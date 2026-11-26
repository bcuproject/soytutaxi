-- SoyTuTaxi · Job board for advance airport jobs + nearest-first auto-dispatch for urgent ones.
--
-- Rules (policy keys, with defaults used when a key is absent):
--   board_min_lead_hours            6   jobs closer than this are urgent → nearest-first
--   board_escalate_hours_before    12   unclaimed board jobs switch to nearest-first at this point
--   board_max_claims_per_day        4   board claims one driver may hold per local pickup day
--   board_release_until_hours_before 24 a driver may drop a claimed job until this point
--   auto_dispatch_max_rounds        5   automatic nearest-first rounds before dispatch must act
-- A job is "on the board" while it needs a driver, is not held by dispatch, has not been pushed to
-- nearest-first, and its pickup is further away than max(board_min_lead_hours, board_escalate_hours_before).

alter table public.bookings
  add column board_hold boolean not null default false,
  add column board_closed_at timestamptz,
  add column auto_dispatch boolean not null default false,
  add column auto_rounds int not null default 0 check (auto_rounds >= 0);

alter table public.assignments
  add column claim_source text check (claim_source is null or claim_source in ('staff', 'offer', 'board'));

create index bookings_board_idx on public.bookings (operator_id, agreed_pickup_at)
  where state = 'needs_driver' and not board_hold and board_closed_at is null;

-- ---------------------------------------------------------------------------
-- Settings helpers
-- ---------------------------------------------------------------------------
create or replace function app.setting_int(b public.bookings, p_key text, p_default int) returns int
language sql stable set search_path = public, pg_temp as $$
  select coalesce((app.policy_for(b) ->> p_key)::int, p_default);
$$;

create or replace function app.board_cutoff_hours(b public.bookings) returns int
language sql stable set search_path = public, pg_temp as $$
  select greatest(app.setting_int(b, 'board_min_lead_hours', 6), app.setting_int(b, 'board_escalate_hours_before', 12));
$$;

create or replace function app.on_board(b public.bookings) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select b.state = 'needs_driver' and not b.board_hold and b.board_closed_at is null
         and b.agreed_pickup_at > now() + make_interval(hours => app.board_cutoff_hours(b));
$$;

-- Open an exception once per booking and kind (no duplicates while one is unresolved).
create or replace function app.raise_exception_once(b public.bookings, p_kind text, p_severity public.exception_severity, p_summary text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.exceptions where booking_id = b.id and kind = p_kind and state <> 'resolved') then
    insert into public.exceptions (operator_id, booking_id, kind, severity, summary, due_at)
    values (b.operator_id, b.id, p_kind, p_severity, p_summary, b.agreed_pickup_at - interval '2 hours');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Allocation now records how the job was taken (staff / offer / board).
-- ---------------------------------------------------------------------------
create or replace function app.allocate(
  b public.bookings, p_driver uuid, p_vehicle uuid, p_actor uuid, p_offer uuid, p_source text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pol jsonb := app.policy_for(b);
  v_reason text;
  v_turn int := coalesce((pol ->> 'turnaround_minutes')::int, 20);
  v_payments_live boolean := coalesce((pol ->> 'payments_enabled')::boolean, false);
  v_hold boolean;
  v_assignment uuid;
  v_new_state public.booking_state;
  v_driver_name text;
begin
  perform 1 from public.drivers where id = p_driver for update;
  perform 1 from public.vehicles where id = p_vehicle for update;

  v_reason := app.ineligible_reason(b, p_driver, p_vehicle);
  if v_reason is not null then perform app.fail(v_reason, 422); end if;

  v_hold := b.payment_mode = 'prepaid' and v_payments_live and b.collection_state <> 'collected';
  v_new_state := case when v_hold then 'held' else 'confirmed' end;

  begin
    insert into public.assignments (operator_id, booking_id, driver_id, vehicle_id, state, hold_expires_at, occupied,
                                    earnings_minor, earnings_currency, created_by, claim_source)
    values (b.operator_id, b.id, p_driver, p_vehicle,
            case when v_hold then 'reserving' else 'confirmed' end::public.assignment_state,
            case when v_hold then now() + make_interval(mins => coalesce((pol ->> 'hold_minutes')::int, 15)) end,
            tstzrange(b.agreed_pickup_at, b.agreed_pickup_at + make_interval(mins => b.est_duration_min + v_turn), '[)'),
            app.driver_share_minor(b), b.currency, p_actor,
            case when p_source in ('staff', 'offer', 'board') then p_source end)
    returning id into v_assignment;
  exception
    when exclusion_violation then perform app.fail('schedule_conflict', 409, 'Driver or vehicle already has an overlapping job.');
    when unique_violation then perform app.fail('already_assigned', 409, 'This booking already has a driver.');
  end;

  update public.booking_offers set status = 'superseded', responded_at = now()
   where booking_id = b.id and status = 'open' and id is distinct from p_offer;

  update public.bookings set state = v_new_state, version = version + 1, auto_dispatch = false where id = b.id;
  select full_name into v_driver_name from public.drivers where id = p_driver;

  insert into public.trip_events (operator_id, booking_id, assignment_id, kind, from_value, to_value, actor_id, payload)
  values (b.operator_id, b.id, v_assignment, 'booking.state_changed', b.state::text, v_new_state::text, p_actor,
          jsonb_build_object('driver', v_driver_name, 'via', p_source, 'offer_id', p_offer));

  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload) values
    (b.operator_id, case when v_hold then 'payment.create_link' else 'notify.passenger.confirmed' end,
     'booking:' || b.id || ':' || v_new_state || ':v' || (b.version + 1), jsonb_build_object('booking_id', b.id)),
    (b.operator_id, 'notify.driver.assigned', 'assignment:' || v_assignment || ':assigned',
     jsonb_build_object('assignment_id', v_assignment))
  on conflict do nothing;

  return v_assignment;
end $$;

-- ---------------------------------------------------------------------------
-- Offer rounds, shared by dispatch and automatic escalation. Caller holds the booking lock.
-- p_fresh_only: skip drivers who already declined or let an offer for this booking expire.
-- ---------------------------------------------------------------------------
create or replace function app.offer_core(
  b public.bookings, p_actor uuid, p_driver_ids uuid[], p_group_size int, p_fresh_only boolean
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pol jsonb := app.policy_for(b); v_gen int; v_expires timestamptz; v_n int := 0; v_size int; r record;
  v_lat double precision; v_lng double precision; v_vehicle uuid;
begin
  if b.state <> 'needs_driver' then perform app.fail('booking_not_open', 409, 'Only bookings without a driver can be offered.'); end if;
  v_size := least(greatest(coalesce(p_group_size, (pol ->> 'auto_offer_group_size')::int, 3), 1), 20);
  v_gen := b.offer_generation + 1;
  v_expires := now() + make_interval(mins => coalesce((pol ->> 'offer_expiry_minutes')::int, 10));

  if b.direction = 'from_airport' then
    select lat, lng into v_lat, v_lng from public.airports where id = b.airport_id;
  else
    select avg((p ->> 1)::float8), avg((p ->> 0)::float8) into v_lat, v_lng
      from public.zones z, jsonb_array_elements(z.polygon -> 0) p where z.id = b.zone_id;
  end if;

  update public.booking_offers set status = 'superseded', responded_at = now()
   where booking_id = b.id and status = 'open';

  for r in
    select d.id, app.driver_vehicle_at(d.id, b.agreed_pickup_at) as vehicle_id
      from public.drivers d
      left join public.driver_locations l on l.driver_id = d.id and l.recorded_at > now() - interval '10 minutes'
     where d.operator_id = b.operator_id and d.active and d.approval_status = 'approved'
       and (p_driver_ids is null or d.id = any (p_driver_ids))
       and (not p_fresh_only or not exists (
             select 1 from public.booking_offers o
              where o.booking_id = b.id and o.driver_id = d.id and o.status in ('declined', 'expired')))
     order by d.on_shift desc,
              case when l.lat is null then 1e9
                   else (l.lat - v_lat) ^ 2 + ((l.lng - v_lng) * cos(radians(coalesce(v_lat, 0)))) ^ 2 end,
              d.id
  loop
    exit when p_driver_ids is null and v_n >= v_size;
    v_vehicle := r.vehicle_id;
    if app.ineligible_reason(b, r.id, v_vehicle) is not null then continue; end if;
    if exists (select 1 from public.assignments s
                where s.driver_id = r.id and s.state <> 'released'
                  and s.occupied && tstzrange(b.agreed_pickup_at,
                        b.agreed_pickup_at + make_interval(mins => b.est_duration_min + coalesce((pol ->> 'turnaround_minutes')::int, 20)), '[)')) then
      continue;
    end if;
    insert into public.booking_offers (operator_id, booking_id, driver_id, vehicle_id, generation, earnings_minor, earnings_currency, expires_at, created_by)
    values (b.operator_id, b.id, r.id, v_vehicle, v_gen, app.driver_share_minor(b), coalesce(b.currency, 'USD'), v_expires, p_actor);
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (b.operator_id, 'notify.driver.offer', 'offer:' || b.id || ':' || v_gen || ':' || r.id,
            jsonb_build_object('booking_id', b.id, 'driver_id', r.id, 'generation', v_gen));
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then perform app.fail('no_eligible_drivers', 422, 'No eligible driver is free for this trip.'); end if;
  -- Offering takes the job off the board.
  update public.bookings set offer_generation = v_gen, version = version + 1, board_closed_at = coalesce(board_closed_at, now())
   where id = b.id;
  insert into public.trip_events (operator_id, booking_id, kind, to_value, actor_id, payload)
  values (b.operator_id, b.id, 'booking.offered', 'needs_driver', p_actor,
          jsonb_build_object('generation', v_gen, 'drivers', v_n, 'automatic', p_actor is null));
  return jsonb_build_object('generation', v_gen, 'expires_at', v_expires, 'offered', v_n, 'version', b.version + 1);
end $$;

create or replace function public.dispatch_offer(
  p_booking uuid, p_expected_version int, p_driver_ids uuid[] default null, p_group_size int default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid;
begin
  perform app.expire_stale();
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  return app.offer_core(b, v_actor, p_driver_ids, p_group_size, false);
end $$;

-- ---------------------------------------------------------------------------
-- Automatic escalation (cron every 2 minutes): unclaimed board jobs and urgent bookings are offered
-- to the nearest eligible drivers in rounds; dispatch is alerted when rounds run out.
-- ---------------------------------------------------------------------------
create or replace function app.escalate_board() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; n int := 0; v_max int; v_first boolean;
begin
  perform app.expire_stale();
  for b in
    select * from public.bookings bk
     where bk.state = 'needs_driver' and not bk.board_hold and bk.agreed_pickup_at > now()
       and (
         (bk.board_closed_at is null and bk.agreed_pickup_at <= now() + make_interval(hours => app.board_cutoff_hours(bk)))
         or (bk.auto_dispatch and not exists (select 1 from public.booking_offers o where o.booking_id = bk.id and o.status = 'open'))
       )
     order by bk.agreed_pickup_at
     for update skip locked
  loop
    v_max := app.setting_int(b, 'auto_dispatch_max_rounds', 5);
    v_first := not b.auto_dispatch;
    if b.auto_rounds >= v_max then
      perform app.raise_exception_once(b, 'auto_dispatch_exhausted', 'critical',
        'Nadie aceptó ' || b.reference || ' tras ' || b.auto_rounds || ' rondas automáticas');
      continue;
    end if;
    update public.bookings set auto_dispatch = true, board_closed_at = coalesce(board_closed_at, now()) where id = b.id
      returning * into b;
    if v_first then
      perform app.raise_exception_once(b, 'auto_dispatch_started', 'warning',
        b.reference || ' sin chofer: se ofrece automáticamente a los más cercanos');
    end if;
    begin
      perform app.offer_core(b, null, null, null, true);
      update public.bookings set auto_rounds = auto_rounds + 1 where id = b.id;
      n := n + 1;
    exception when others then
      if sqlerrm = 'no_eligible_drivers' then
        perform app.raise_exception_once(b, 'no_driver_available', 'critical',
          'No hay choferes libres y habilitados para ' || b.reference);
      else
        raise;
      end if;
    end;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Driver commands: board, claim, drop
-- ---------------------------------------------------------------------------
create or replace function public.driver_board() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); v_cap int; v_release int; v_cutoff int;
begin
  perform app.expire_stale();
  select app.setting_int(b, 'board_max_claims_per_day', 4), app.setting_int(b, 'board_release_until_hours_before', 24),
         app.board_cutoff_hours(b)
    into v_cap, v_release, v_cutoff
    from public.bookings b where b.operator_id = d.operator_id order by b.created_at desc limit 1;
  return jsonb_build_object(
    'maxPerDay', coalesce(v_cap, 4),
    'releaseUntilHours', coalesce(v_release, 24),
    'escalateHours', coalesce(v_cutoff, 12),
    'claimsByDay', coalesce((
      select jsonb_object_agg(day, n) from (
        select (bk.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date::text as day, count(*) as n
          from public.assignments s join public.bookings bk on bk.id = s.booking_id
         where s.driver_id = d.id and s.state <> 'released' and s.claim_source = 'board' and bk.agreed_pickup_at > now()
         group by 1) x), '{}'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bookingId', b.id, 'pickupAt', b.agreed_pickup_at,
        'pickupLocalDate', (b.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date,
        'direction', b.direction, 'airport', a.iata, 'zone', z.name, 'flight', b.flight_designator,
        'passengers', b.passengers, 'largeBags', b.large_bags, 'carryOn', b.carry_on, 'vehicleClass', b.vehicle_class,
        'estDurationMin', b.est_duration_min, 'earningsMinor', app.driver_share_minor(b), 'currency', coalesce(b.currency, 'USD'))
        order by b.agreed_pickup_at)
      from public.bookings b
      join public.airports a on a.id = b.airport_id
      left join public.zones z on z.id = b.zone_id
      where b.operator_id = d.operator_id and app.on_board(b)
        and app.ineligible_reason(b, d.id, app.driver_vehicle_at(d.id, b.agreed_pickup_at)) is null
        and not exists (
          select 1 from public.assignments s
           where s.driver_id = d.id and s.state <> 'released'
             and s.occupied && tstzrange(b.agreed_pickup_at,
                   b.agreed_pickup_at + make_interval(mins => b.est_duration_min + app.setting_int(b, 'turnaround_minutes', 20)), '[)'))
    ), '[]'::jsonb));
end $$;

create or replace function public.driver_claim(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); b public.bookings; v_cap int; v_held int; v_assignment uuid;
begin
  perform app.expire_stale();
  select * into b from public.bookings where id = p_booking and operator_id = d.operator_id;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  b := app.lock_booking(p_booking, null);
  if b.state <> 'needs_driver' then return jsonb_build_object('outcome', 'already_taken'); end if;
  if not app.on_board(b) then return jsonb_build_object('outcome', 'not_on_board'); end if;

  v_cap := app.setting_int(b, 'board_max_claims_per_day', 4);
  perform 1 from public.drivers where id = d.id for update;   -- serialise this driver's claims for the cap
  select count(*) into v_held
    from public.assignments s join public.bookings bk on bk.id = s.booking_id
   where s.driver_id = d.id and s.state <> 'released' and s.claim_source = 'board'
     and (bk.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date
       = (b.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date;
  if v_held >= v_cap then
    perform app.fail('claim_limit_reached', 409, 'You already hold the maximum board jobs for that day.');
  end if;

  v_assignment := app.allocate(b, d.id, app.driver_vehicle_at(d.id, b.agreed_pickup_at), d.auth_user_id, null, 'board');
  return (select jsonb_build_object('outcome', 'claimed', 'assignment_id', v_assignment, 'booking_state', state)
            from public.bookings where id = b.id);
end $$;

create or replace function public.driver_release_claim(p_assignment uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); s public.assignments; b public.bookings; v_hours int;
begin
  select * into s from public.assignments where id = p_assignment;
  if s.id is null or s.driver_id <> d.id or s.state = 'released' then perform app.fail('job_not_found', 404); end if;
  b := app.lock_booking(s.booking_id, null);
  v_hours := app.setting_int(b, 'board_release_until_hours_before', 24);
  if b.agreed_pickup_at <= now() + make_interval(hours => v_hours) then
    perform app.fail('release_window_closed', 409, 'Too close to pickup — ask dispatch to reassign.');
  end if;
  if s.trip_stage <> 'scheduled' then perform app.fail('job_in_progress', 409); end if;
  perform app.release_active(b, d.auth_user_id, 'driver_dropped' || coalesce(': ' || nullif(trim(p_reason), ''), ''));
  -- Back on the board for other drivers.
  update public.bookings set state = 'needs_driver', version = version + 1,
         board_closed_at = null, auto_dispatch = false, auto_rounds = 0
   where id = b.id returning * into b;
  insert into public.trip_events (operator_id, booking_id, assignment_id, kind, from_value, to_value, actor_id, payload)
  values (b.operator_id, b.id, s.id, 'booking.state_changed', 'confirmed', 'needs_driver', d.auth_user_id,
          jsonb_build_object('reason', 'driver_dropped', 'driver', d.full_name));
  return jsonb_build_object('outcome', 'released', 'on_board', app.on_board(b));
end $$;

-- ---------------------------------------------------------------------------
-- Dispatch control of the board: hold off the board, publish back to it, or push to nearest-first.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_board(p_booking uuid, p_action text, p_expected_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid;
begin
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  if b.state <> 'needs_driver' then perform app.fail('booking_not_open', 409); end if;

  if p_action = 'hold' then
    update public.booking_offers set status = 'superseded', responded_at = now() where booking_id = b.id and status = 'open';
    update public.bookings set board_hold = true, auto_dispatch = false, version = version + 1 where id = b.id returning * into b;
  elsif p_action = 'publish' then
    update public.booking_offers set status = 'superseded', responded_at = now() where booking_id = b.id and status = 'open';
    update public.bookings set board_hold = false, board_closed_at = null, auto_dispatch = false, auto_rounds = 0, version = version + 1
     where id = b.id returning * into b;
  elsif p_action = 'auto' then
    update public.bookings set board_hold = false, auto_dispatch = true, auto_rounds = 0,
           board_closed_at = coalesce(board_closed_at, now()) where id = b.id returning * into b;
    perform app.offer_core(b, v_actor, null, null, false);
    update public.bookings set auto_rounds = 1 where id = b.id returning * into b;
  else
    perform app.fail('invalid_action', 422);
  end if;

  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, v_actor, 'user', 'booking.board_' || p_action, 'bookings', b.id, '{}');
  return jsonb_build_object('on_board', app.on_board(b), 'board_hold', b.board_hold, 'auto_dispatch', b.auto_dispatch, 'version', b.version);
end $$;

-- Driver jobs now say whether the driver may still drop the job.
create or replace function public.driver_jobs() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignmentId', s.id, 'version', s.version, 'state', s.state, 'tripStage', s.trip_stage, 'holdExpiresAt', s.hold_expires_at,
      'reference', b.reference, 'bookingState', b.state, 'direction', b.direction, 'airport', a.iata,
      'meetingPoint', a.meeting_point_es, 'pickup', b.pickup_place, 'dropoff', b.dropoff_place, 'zone', z.name,
      'pickupAt', b.agreed_pickup_at, 'proposedPickupAt', b.proposed_pickup_at, 'estDurationMin', b.est_duration_min,
      'passengers', b.passengers, 'largeBags', b.large_bags, 'carryOn', b.carry_on, 'vehicleClass', b.vehicle_class,
      'flight', b.flight_designator, 'notes', b.notes, 'paymentMode', b.payment_mode, 'collectionState', b.collection_state,
      'amountMinor', b.amount_minor, 'currency', b.currency, 'earningsMinor', s.earnings_minor,
      'claimSource', s.claim_source,
      'canDrop', s.trip_stage = 'scheduled'
                 and b.agreed_pickup_at > now() + make_interval(hours => app.setting_int(b, 'board_release_until_hours_before', 24)),
      'passenger', jsonb_build_object('name', p.full_name, 'phone', p.phone_e164, 'locale', p.locale))
      order by b.agreed_pickup_at)
    from public.assignments s
    join public.bookings b on b.id = s.booking_id
    join public.airports a on a.id = b.airport_id
    join public.passengers p on p.id = b.passenger_id
    left join public.zones z on z.id = b.zone_id
    where s.driver_id = d.id and s.state <> 'released'
      and (s.trip_stage not in ('complete', 'no_show') or s.updated_at > now() - interval '24 hours')), '[]'::jsonb);
end $$;

-- Dispatch read model gains board columns (appended, so existing columns keep their order).
create or replace view public.dispatch_booking_rows with (security_invoker = true) as
select
  b.id, b.operator_id, b.reference, b.source, b.state, b.direction,
  a.iata as airport, z.name as zone_name, b.zone_id,
  b.pickup_place, b.dropoff_place,
  b.agreed_pickup_at, b.proposed_pickup_at, b.est_duration_min,
  (b.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date as pickup_local_date,
  b.passengers, b.large_bags, b.carry_on, b.vehicle_class,
  b.flight_designator, b.flight_local_arrival_date, b.flight_exception_reason,
  b.payment_mode, b.collection_state, b.amount_minor, b.currency,
  b.version, b.notes, b.created_at,
  p.full_name as passenger_name, p.phone_e164 as passenger_phone, p.email as passenger_email, b.locale,
  s.id as assignment_id, s.state as assignment_state, s.trip_stage, s.hold_expires_at,
  d.id as driver_id, d.full_name as driver_name,
  v.id as vehicle_id, v.plate as vehicle_plate,
  b.board_hold, b.board_closed_at, b.auto_dispatch, b.auto_rounds,
  app.on_board(b) as on_board,
  s.claim_source,
  (select count(*) from public.booking_offers o where o.booking_id = b.id and o.status = 'open')::int as open_offers
from public.bookings b
join public.airports a   on a.id = b.airport_id
join public.passengers p on p.id = b.passenger_id
left join public.zones z on z.id = b.zone_id
left join public.assignments s on s.booking_id = b.id and s.state <> 'released'
left join public.drivers d  on d.id = s.driver_id
left join public.vehicles v on v.id = s.vehicle_id;

grant select on public.dispatch_booking_rows to authenticated;
grant execute on function app.on_board(public.bookings), app.board_cutoff_hours(public.bookings),
  app.setting_int(public.bookings, text, int), app.policy_for(public.bookings) to authenticated;

revoke all on function app.offer_core(public.bookings, uuid, uuid[], int, boolean), app.escalate_board(),
  app.raise_exception_once(public.bookings, text, public.exception_severity, text) from public, anon, authenticated;
revoke all on function public.driver_board(), public.driver_claim(uuid), public.driver_release_claim(uuid, text),
  public.dispatch_board(uuid, text, int) from public, anon;
grant execute on function public.driver_board(), public.driver_claim(uuid), public.driver_release_claim(uuid, text),
  public.dispatch_board(uuid, text, int) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-board-escalation', '*/2 * * * *', 'select app.escalate_board()');
  end if;
end $$;
