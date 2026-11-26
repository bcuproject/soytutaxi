-- SoyTuTaxi · Phase 2: driver operations, offers/assignment, trip progress, earnings ledger,
-- live driver locations (for the dispatch map). All writes are SECURITY DEFINER commands that
-- check the caller's role themselves; staff and drivers call them directly via PostgREST RPC.

create type public.offer_status as enum ('open', 'accepted', 'declined', 'expired', 'superseded');

alter table public.drivers
  add column on_shift boolean not null default false,
  add column shift_changed_at timestamptz;

alter table public.bookings
  add column offer_generation int not null default 0;

-- ---------------------------------------------------------------------------
-- Offers: one per driver per generation
-- ---------------------------------------------------------------------------
create table public.booking_offers (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators(id) on delete cascade,
  booking_id         uuid not null references public.bookings(id) on delete cascade,
  driver_id          uuid not null references public.drivers(id),
  vehicle_id         uuid not null references public.vehicles(id),
  generation         int not null,
  status             public.offer_status not null default 'open',
  earnings_minor     bigint not null check (earnings_minor >= 0),
  earnings_currency  char(3) not null,
  expires_at         timestamptz not null,
  responded_at       timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  unique (booking_id, driver_id, generation)
);
create index booking_offers_open_idx on public.booking_offers (expires_at) where status = 'open';
create index booking_offers_driver_idx on public.booking_offers (driver_id, status);

-- ---------------------------------------------------------------------------
-- Live locations: latest point per driver + short trail
-- ---------------------------------------------------------------------------
create table public.driver_locations (
  driver_id    uuid primary key references public.drivers(id) on delete cascade,
  operator_id  uuid not null references public.operators(id) on delete cascade,
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  accuracy_m   real check (accuracy_m is null or accuracy_m >= 0),
  heading      real check (heading is null or (heading >= 0 and heading < 360)),
  speed_mps    real check (speed_mps is null or speed_mps >= 0),
  recorded_at  timestamptz not null,
  received_at  timestamptz not null default now()
);

create table public.driver_location_trail (
  id           bigint generated always as identity primary key,
  operator_id  uuid not null references public.operators(id) on delete cascade,
  driver_id    uuid not null references public.drivers(id) on delete cascade,
  lat          double precision not null,
  lng          double precision not null,
  recorded_at  timestamptz not null
);
create index driver_location_trail_idx on public.driver_location_trail (driver_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Earnings and cash (immutable, signed entries)
-- ---------------------------------------------------------------------------
create table public.earnings_entries (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id) on delete cascade,
  driver_id       uuid not null references public.drivers(id),
  assignment_id   uuid references public.assignments(id),
  booking_id      uuid references public.bookings(id),
  kind            text not null check (kind in ('trip', 'adjustment')),
  amount_minor    bigint not null,
  currency        char(3) not null,
  note            text,
  settlement_batch_id uuid,
  settled_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
-- One trip earning per assignment, however often completion is retried.
create unique index earnings_one_trip_per_assignment on public.earnings_entries (assignment_id) where kind = 'trip';
create index earnings_driver_idx on public.earnings_entries (driver_id, created_at);

create table public.cash_entries (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id) on delete cascade,
  driver_id       uuid not null references public.drivers(id),
  assignment_id   uuid not null unique references public.assignments(id),
  booking_id      uuid not null references public.bookings(id),
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null,
  reconciled_at   timestamptz,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['booking_offers','driver_location_trail','earnings_entries','cash_entries']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (app.is_staff(operator_id))', t || '_staff_read', t);
  end loop;
end $$;
create policy booking_offers_self_read on public.booking_offers for select to authenticated
  using (driver_id in (select app.current_driver_ids()));
alter table public.driver_locations enable row level security;
alter table public.driver_locations force row level security;
-- Staff see a driver's position only while that driver is on shift.
create policy driver_locations_staff_read on public.driver_locations for select to authenticated
  using (app.is_staff(operator_id) and exists (select 1 from public.drivers d where d.id = driver_id and d.on_shift));
create policy driver_locations_self_read on public.driver_locations for select to authenticated
  using (driver_id in (select app.current_driver_ids()));
create policy earnings_self_read on public.earnings_entries for select to authenticated
  using (driver_id in (select app.current_driver_ids()));
create policy cash_self_read on public.cash_entries for select to authenticated
  using (driver_id in (select app.current_driver_ids()));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.require_role(p_operator uuid, p_roles public.member_role[])
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not app.has_role(p_operator, p_roles) then
    perform app.fail('forbidden', 403);
  end if;
  return auth.uid();
end $$;

-- The signed-in, approved, active driver (raises 403 otherwise).
create or replace function app.me_driver() returns public.drivers
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers;
begin
  select * into d from public.drivers
   where auth_user_id = auth.uid() and active and approval_status = 'approved';
  if d.id is null then perform app.fail('not_a_driver', 403); end if;
  return d;
end $$;

create or replace function app.policy_for(p_booking public.bookings) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select config from public.policies where id = p_booking.policy_id;
$$;

-- Vehicle allocated to a driver at an instant.
create or replace function app.driver_vehicle_at(p_driver uuid, p_at timestamptz) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select vehicle_id from public.driver_vehicle_allocations
   where driver_id = p_driver and active and period @> p_at
   order by lower(period) desc limit 1;
$$;

-- Working hours: unavailability always wins; otherwise an explicit available window or a
-- recurring shift (local weekday/time in the operator timezone) must cover the pickup instant.
create or replace function app.driver_works_at(p_driver uuid, p_from timestamptz, p_to timestamptz, p_tz text)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select not exists (
           select 1 from public.driver_availability a
            where a.driver_id = p_driver and a.kind = 'unavailable' and a.during && tstzrange(p_from, p_to, '[)'))
     and (
       exists (select 1 from public.driver_availability a
                where a.driver_id = p_driver and a.kind = 'available' and a.during @> p_from)
       or exists (
         select 1 from public.driver_availability a
          where a.driver_id = p_driver and a.kind = 'recurring_shift'
            and a.weekday = extract(dow from (p_from at time zone p_tz))::int
            and a.effective @> (p_from at time zone p_tz)::date
            and (p_from at time zone p_tz)::time >= a.start_local
            and (p_from at time zone p_tz)::time <  a.end_local)
     );
$$;

-- Why a driver/vehicle cannot take a booking (NULL = eligible). Overlaps are left to the
-- exclusion constraints so the check stays race-free.
create or replace function app.ineligible_reason(b public.bookings, p_driver uuid, p_vehicle uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers; v public.vehicles; vc public.vehicle_classes; tz text; pol jsonb;
begin
  select * into d from public.drivers where id = p_driver and operator_id = b.operator_id;
  if d.id is null then return 'unknown_driver'; end if;
  if not d.active or d.approval_status <> 'approved' then return 'driver_not_approved'; end if;
  if p_vehicle is null then return 'no_vehicle_allocated'; end if;
  select * into v from public.vehicles where id = p_vehicle and operator_id = b.operator_id;
  if v.id is null or not v.active then return 'vehicle_unavailable'; end if;
  if app.driver_vehicle_at(p_driver, b.agreed_pickup_at) is distinct from p_vehicle then return 'vehicle_not_allocated_to_driver'; end if;
  select * into vc from public.vehicle_classes where operator_id = b.operator_id and code = v.vehicle_class;
  if b.passengers > coalesce(v.max_passengers, vc.max_passengers)
     or b.large_bags > coalesce(v.max_large_bags, vc.max_large_bags)
     or b.carry_on  > coalesce(v.max_carry_on, vc.max_carry_on)
     or (vc.max_bag_units is not null and b.large_bags * 2 + b.carry_on > vc.max_bag_units) then
    return 'vehicle_too_small';
  end if;
  select timezone into tz from public.operators where id = b.operator_id;
  pol := app.policy_for(b);
  if not app.driver_works_at(p_driver, b.agreed_pickup_at,
        b.agreed_pickup_at + make_interval(mins => b.est_duration_min), tz) then
    return 'outside_working_hours';
  end if;
  return null;
end $$;

create or replace function app.driver_share_minor(b public.bookings) returns bigint
language sql stable set search_path = public, pg_temp as $$
  select round(coalesce(b.amount_minor, 0) * coalesce((app.policy_for(b) ->> 'driver_share_percent')::numeric, 80) / 100)::bigint;
$$;

-- Release holds and offers that have expired (database clock). Safe to call anywhere.
create or replace function app.expire_stale() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  update public.booking_offers set status = 'expired', responded_at = now()
   where status = 'open' and expires_at <= now();
  for r in
    select s.id as assignment_id, s.booking_id, s.operator_id
      from public.assignments s
     where s.state = 'reserving' and s.hold_expires_at <= now()
     for update skip locked
  loop
    update public.assignments set state = 'released', released_reason = 'hold_expired', version = version + 1 where id = r.assignment_id;
    update public.bookings set state = 'needs_driver', version = version + 1
     where id = r.booking_id and state = 'held';
    insert into public.trip_events (operator_id, booking_id, assignment_id, kind, from_value, to_value, payload)
    values (r.operator_id, r.booking_id, r.assignment_id, 'booking.state_changed', 'held', 'needs_driver', '{"reason":"hold_expired"}');
    n := n + 1;
  end loop;
  return n;
end $$;

-- Core allocation, shared by staff assignment and driver acceptance. Caller holds the booking lock.
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
  -- Consistent lock order: booking (caller) → driver → vehicle.
  perform 1 from public.drivers where id = p_driver for update;
  perform 1 from public.vehicles where id = p_vehicle for update;

  v_reason := app.ineligible_reason(b, p_driver, p_vehicle);
  if v_reason is not null then perform app.fail(v_reason, 422); end if;

  -- Prepaid bookings wait for verified funds only once online payments are live (Phase 4).
  v_hold := b.payment_mode = 'prepaid' and v_payments_live and b.collection_state <> 'collected';
  v_new_state := case when v_hold then 'held' else 'confirmed' end;

  begin
    insert into public.assignments (operator_id, booking_id, driver_id, vehicle_id, state, hold_expires_at, occupied,
                                    earnings_minor, earnings_currency, created_by)
    values (b.operator_id, b.id, p_driver, p_vehicle,
            case when v_hold then 'reserving' else 'confirmed' end::public.assignment_state,
            case when v_hold then now() + make_interval(mins => coalesce((pol ->> 'hold_minutes')::int, 15)) end,
            tstzrange(b.agreed_pickup_at, b.agreed_pickup_at + make_interval(mins => b.est_duration_min + v_turn), '[)'),
            app.driver_share_minor(b), b.currency, p_actor)
    returning id into v_assignment;
  exception
    when exclusion_violation then perform app.fail('schedule_conflict', 409, 'Driver or vehicle already has an overlapping job.');
    when unique_violation then perform app.fail('already_assigned', 409, 'This booking already has a driver.');
  end;

  update public.booking_offers set status = 'superseded', responded_at = now()
   where booking_id = b.id and status = 'open' and id is distinct from p_offer;

  update public.bookings set state = v_new_state, version = version + 1 where id = b.id;
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

create or replace function app.lock_booking(p_booking uuid, p_expected_version int) returns public.bookings
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  if p_expected_version is not null and b.version <> p_expected_version then
    perform app.fail('stale_version', 409, 'The booking changed since you loaded it. Refresh and try again.');
  end if;
  return b;
end $$;

-- Release an active assignment (booking lock held). Records the passenger impact.
create or replace function app.release_active(b public.bookings, p_actor uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.assignments;
begin
  select * into s from public.assignments where booking_id = b.id and state <> 'released' for update;
  if s.id is null then return; end if;
  update public.assignments set state = 'released', released_reason = p_reason, version = version + 1 where id = s.id;
  insert into public.trip_events (operator_id, booking_id, assignment_id, kind, from_value, to_value, actor_id, payload)
  values (b.operator_id, b.id, s.id, 'assignment.released', s.state::text, 'released', p_actor, jsonb_build_object('reason', p_reason));
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
  values (b.operator_id, 'notify.driver.released', 'assignment:' || s.id || ':released', jsonb_build_object('assignment_id', s.id))
  on conflict do nothing;
  if s.state = 'confirmed' then
    insert into public.exceptions (operator_id, booking_id, kind, severity, summary, evidence, due_at)
    values (b.operator_id, b.id, 'lost_cover',
            case when b.agreed_pickup_at < now() + interval '12 hours' then 'critical' else 'warning' end::public.exception_severity,
            'Confirmed trip ' || b.reference || ' lost its driver',
            jsonb_build_object('reason', p_reason, 'collection_state', b.collection_state),
            b.agreed_pickup_at - interval '2 hours');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Staff commands
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_assign(
  p_booking uuid, p_driver uuid, p_expected_version int, p_vehicle uuid default null, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid; v_vehicle uuid; v_assignment uuid; v_has_active boolean;
begin
  perform app.expire_stale();
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  if b.state in ('cancelled', 'closed') then perform app.fail('booking_closed', 409); end if;

  select exists (select 1 from public.assignments where booking_id = b.id and state <> 'released') into v_has_active;
  if v_has_active then
    if nullif(trim(p_reason), '') is null then perform app.fail('reason_required', 422, 'Replacing a driver needs a reason.'); end if;
    perform app.release_active(b, v_actor, 'reassigned: ' || p_reason);
    update public.bookings set state = 'needs_driver', version = version + 1 where id = b.id returning * into b;
  end if;

  v_vehicle := coalesce(p_vehicle, app.driver_vehicle_at(p_driver, b.agreed_pickup_at));
  v_assignment := app.allocate(b, p_driver, v_vehicle, v_actor, null, 'staff');
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, reason, detail)
  values (b.operator_id, v_actor, 'user', case when v_has_active then 'booking.reassign' else 'booking.assign' end,
          'bookings', b.id, p_reason, jsonb_build_object('driver_id', p_driver, 'vehicle_id', v_vehicle));
  return (select jsonb_build_object('assignment_id', v_assignment, 'booking_state', state, 'version', version)
            from public.bookings where id = b.id);
end $$;

create or replace function public.dispatch_offer(
  p_booking uuid, p_expected_version int, p_driver_ids uuid[] default null, p_group_size int default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.bookings; v_actor uuid; pol jsonb; v_gen int; v_expires timestamptz; v_n int := 0;
  v_size int; r record; v_lat double precision; v_lng double precision; v_vehicle uuid;
begin
  perform app.expire_stale();
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  if b.state <> 'needs_driver' then perform app.fail('booking_not_open', 409, 'Only bookings without a driver can be offered.'); end if;
  pol := app.policy_for(b);
  v_size := least(greatest(coalesce(p_group_size, (pol ->> 'auto_offer_group_size')::int, 3), 1), 20);
  v_gen := b.offer_generation + 1;
  v_expires := now() + make_interval(mins => coalesce((pol ->> 'offer_expiry_minutes')::int, 10));

  -- Pickup point used for ranking: the airport, or the zone's centre for trips to the airport.
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
     order by d.on_shift desc,
              case when l.lat is null then 1e9
                   else (l.lat - v_lat) ^ 2 + ((l.lng - v_lng) * cos(radians(coalesce(v_lat, 0)))) ^ 2 end,
              d.id
  loop
    exit when p_driver_ids is null and v_n >= v_size;
    v_vehicle := r.vehicle_id;
    if app.ineligible_reason(b, r.id, v_vehicle) is not null then continue; end if;
    -- Skip drivers whose schedule already overlaps (cheap pre-check; accept re-checks atomically).
    if exists (select 1 from public.assignments s
                where s.driver_id = r.id and s.state <> 'released'
                  and s.occupied && tstzrange(b.agreed_pickup_at,
                        b.agreed_pickup_at + make_interval(mins => b.est_duration_min + coalesce((pol ->> 'turnaround_minutes')::int, 20)), '[)')) then
      continue;
    end if;
    insert into public.booking_offers (operator_id, booking_id, driver_id, vehicle_id, generation, earnings_minor, earnings_currency, expires_at, created_by)
    values (b.operator_id, b.id, r.id, v_vehicle, v_gen, app.driver_share_minor(b), coalesce(b.currency, 'USD'), v_expires, v_actor);
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (b.operator_id, 'notify.driver.offer', 'offer:' || b.id || ':' || v_gen || ':' || r.id,
            jsonb_build_object('booking_id', b.id, 'driver_id', r.id, 'generation', v_gen));
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then perform app.fail('no_eligible_drivers', 422, 'No eligible driver is free for this trip.'); end if;
  update public.bookings set offer_generation = v_gen, version = version + 1 where id = b.id;
  insert into public.trip_events (operator_id, booking_id, kind, to_value, actor_id, payload)
  values (b.operator_id, b.id, 'booking.offered', 'needs_driver', v_actor, jsonb_build_object('generation', v_gen, 'drivers', v_n));
  return jsonb_build_object('generation', v_gen, 'expires_at', v_expires, 'offered', v_n, 'version', b.version + 1);
end $$;

create or replace function public.dispatch_release(p_booking uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid;
begin
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  if nullif(trim(p_reason), '') is null then perform app.fail('reason_required', 422); end if;
  b := app.lock_booking(p_booking, p_expected_version);
  if b.state not in ('held', 'confirmed') then perform app.fail('no_active_driver', 409); end if;
  perform app.release_active(b, v_actor, p_reason);
  update public.bookings set state = 'needs_driver', version = version + 1 where id = b.id returning * into b;
  insert into public.trip_events (operator_id, booking_id, kind, to_value, actor_id, payload)
  values (b.operator_id, b.id, 'booking.state_changed', 'needs_driver', v_actor, jsonb_build_object('reason', p_reason));
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, reason)
  values (b.operator_id, v_actor, 'user', 'booking.release', 'bookings', b.id, p_reason);
  return jsonb_build_object('booking_state', b.state, 'version', b.version);
end $$;

create or replace function public.dispatch_cancel(p_booking uuid, p_expected_version int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid; v_prev public.booking_state;
begin
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  if nullif(trim(p_reason), '') is null then perform app.fail('reason_required', 422); end if;
  b := app.lock_booking(p_booking, p_expected_version);
  if b.state in ('cancelled', 'closed') then perform app.fail('booking_closed', 409); end if;
  v_prev := b.state;
  -- Release without raising a lost-cover exception: the trip itself is cancelled.
  update public.assignments set state = 'released', released_reason = 'booking_cancelled', version = version + 1
   where booking_id = b.id and state <> 'released';
  update public.booking_offers set status = 'superseded', responded_at = now() where booking_id = b.id and status = 'open';
  update public.bookings set state = 'cancelled', cancelled_reason = p_reason, version = version + 1 where id = b.id returning * into b;
  insert into public.trip_events (operator_id, booking_id, kind, from_value, to_value, actor_id, payload)
  values (b.operator_id, b.id, 'booking.state_changed', v_prev::text, 'cancelled', v_actor, jsonb_build_object('reason', p_reason));
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
  values (b.operator_id, 'notify.passenger.cancelled', 'booking:' || b.id || ':cancelled', jsonb_build_object('booking_id', b.id))
  on conflict do nothing;
  if b.collection_state = 'collected' then
    insert into public.exceptions (operator_id, booking_id, kind, severity, summary)
    values (b.operator_id, b.id, 'refund_review', 'warning', 'Cancelled booking ' || b.reference || ' has money received');
  end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, reason)
  values (b.operator_id, v_actor, 'user', 'booking.cancel', 'bookings', b.id, p_reason);
  return jsonb_build_object('booking_state', b.state, 'version', b.version);
end $$;

-- ---------------------------------------------------------------------------
-- Driver commands
-- ---------------------------------------------------------------------------
create or replace function public.driver_set_shift(p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver();
begin
  -- Off shift: the position stops being visible to staff (RLS + board view), so nothing is tracked.
  update public.drivers set on_shift = p_on, shift_changed_at = now() where id = d.id and on_shift is distinct from p_on;
  return jsonb_build_object('on_shift', p_on);
end $$;

create or replace function public.driver_report_location(
  p_lat double precision, p_lng double precision, p_accuracy real default null,
  p_heading real default null, p_speed real default null, p_recorded_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); v_at timestamptz := least(coalesce(p_recorded_at, now()), now() + interval '1 minute');
        v_prev timestamptz;
begin
  if not d.on_shift then perform app.fail('off_shift', 409, 'Start your shift to share location.'); end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    perform app.fail('invalid_location', 422);
  end if;
  if v_at < now() - interval '10 minutes' then return jsonb_build_object('stored', false, 'reason', 'too_old'); end if;
  select recorded_at into v_prev from public.driver_locations where driver_id = d.id;
  if v_prev is not null and v_at <= v_prev then
    return jsonb_build_object('stored', false, 'reason', 'stale');      -- out-of-order point, keep newer
  end if;
  insert into public.driver_locations (driver_id, operator_id, lat, lng, accuracy_m, heading, speed_mps, recorded_at, received_at)
  values (d.id, d.operator_id, p_lat, p_lng, p_accuracy,
          case when p_heading >= 0 and p_heading < 360 then p_heading end,
          case when p_speed >= 0 then p_speed end, v_at, now())
  on conflict (driver_id) do update set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
    heading = excluded.heading, speed_mps = excluded.speed_mps, recorded_at = excluded.recorded_at, received_at = now();
  if v_prev is null or v_at - v_prev >= interval '30 seconds' then
    insert into public.driver_location_trail (operator_id, driver_id, lat, lng, recorded_at) values (d.operator_id, d.id, p_lat, p_lng, v_at);
  end if;
  return jsonb_build_object('stored', true);
end $$;

create or replace function public.driver_respond_offer(p_offer uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); o public.booking_offers; b public.bookings; v_assignment uuid;
begin
  perform app.expire_stale();
  select * into o from public.booking_offers where id = p_offer;
  if o.id is null or o.driver_id <> d.id then perform app.fail('offer_not_found', 404); end if;
  b := app.lock_booking(o.booking_id, null);                       -- booking first, then the offer
  select * into o from public.booking_offers where id = p_offer for update;

  -- Idempotent replay of an answer already given.
  if o.status = 'accepted' and p_accept then
    return jsonb_build_object('outcome', 'accepted', 'booking_state', b.state);
  elsif o.status = 'declined' and not p_accept then
    return jsonb_build_object('outcome', 'declined');
  end if;

  if o.status <> 'open' or o.generation <> b.offer_generation then
    return jsonb_build_object('outcome', case when o.status = 'expired' then 'expired' else 'already_taken' end);
  end if;
  if o.expires_at <= now() then
    update public.booking_offers set status = 'expired', responded_at = now() where id = o.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  if not p_accept then
    update public.booking_offers set status = 'declined', responded_at = now() where id = o.id;
    insert into public.trip_events (operator_id, booking_id, kind, actor_id, payload)
    values (b.operator_id, b.id, 'offer.declined', d.auth_user_id, jsonb_build_object('driver', d.full_name));
    return jsonb_build_object('outcome', 'declined');
  end if;

  if b.state <> 'needs_driver' then
    update public.booking_offers set status = 'superseded', responded_at = now() where id = o.id;
    return jsonb_build_object('outcome', 'already_taken');
  end if;

  v_assignment := app.allocate(b, d.id, o.vehicle_id, d.auth_user_id, o.id, 'offer');
  update public.booking_offers set status = 'accepted', responded_at = now() where id = o.id;
  return (select jsonb_build_object('outcome', 'accepted', 'assignment_id', v_assignment, 'booking_state', state)
            from public.bookings where id = b.id);
end $$;

create or replace function public.driver_trip_progress(p_assignment uuid, p_stage public.trip_stage, p_expected_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); s public.assignments; b public.bookings; v_ok boolean;
begin
  select * into s from public.assignments where id = p_assignment;
  if s.id is null or s.driver_id <> d.id then perform app.fail('job_not_found', 404); end if;
  b := app.lock_booking(s.booking_id, null);
  select * into s from public.assignments where id = p_assignment for update;
  if s.state = 'released' then perform app.fail('job_released', 409, 'This job is no longer yours.'); end if;
  if s.state <> 'confirmed' then perform app.fail('job_not_confirmed', 409); end if;
  if s.trip_stage = p_stage then  -- retried tap / reconnect replay
    return jsonb_build_object('trip_stage', s.trip_stage, 'version', s.version, 'replay', true);
  end if;
  if s.version <> p_expected_version then
    perform app.fail('stale_version', 409, 'This job changed. Refresh to see the latest.');
  end if;
  v_ok := (s.trip_stage, p_stage) in (
    ('scheduled','en_route'), ('scheduled','at_pickup'), ('en_route','at_pickup'),
    ('at_pickup','onboard'), ('at_pickup','no_show'), ('onboard','complete'));
  if not v_ok then perform app.fail('invalid_transition', 422, s.trip_stage || ' → ' || p_stage || ' is not allowed'); end if;

  update public.assignments set trip_stage = p_stage, version = version + 1 where id = s.id returning * into s;
  insert into public.trip_events (operator_id, booking_id, assignment_id, kind, to_value, actor_id, payload)
  values (b.operator_id, b.id, s.id, 'trip.stage_changed', p_stage::text, d.auth_user_id, '{}');

  if p_stage = 'complete' then
    update public.bookings set state = 'closed', version = version + 1,
      collection_state = case when payment_mode in ('pay_on_pickup_cash','pay_on_pickup_card') then 'collected' else collection_state end
     where id = b.id;
    insert into public.earnings_entries (operator_id, driver_id, assignment_id, booking_id, kind, amount_minor, currency)
    values (b.operator_id, d.id, s.id, b.id, 'trip', coalesce(s.earnings_minor, app.driver_share_minor(b)), coalesce(s.earnings_currency, b.currency, 'USD'))
    on conflict do nothing;
    if b.payment_mode = 'pay_on_pickup_cash' then
      insert into public.cash_entries (operator_id, driver_id, assignment_id, booking_id, amount_minor, currency)
      values (b.operator_id, d.id, s.id, b.id, coalesce(b.amount_minor, 0), coalesce(b.currency, 'USD'))
      on conflict do nothing;
    end if;
  elsif p_stage = 'no_show' then
    insert into public.exceptions (operator_id, booking_id, kind, severity, summary)
    values (b.operator_id, b.id, 'no_show_review', 'warning', 'Driver reported no-show on ' || b.reference);
  end if;
  return jsonb_build_object('trip_stage', s.trip_stage, 'version', s.version, 'replay', false);
end $$;

-- Driver read models. Contact and exact address only for the driver's own assignments.
create or replace function public.driver_me() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); v public.vehicles;
begin
  select * into v from public.vehicles where id = app.driver_vehicle_at(d.id, now());
  return jsonb_build_object('id', d.id, 'fullName', d.full_name, 'onShift', d.on_shift,
    'vehicle', case when v.id is null then null else jsonb_build_object('plate', v.plate, 'class', v.vehicle_class, 'description', v.description) end,
    'earnings', (select jsonb_build_object(
        'accruedMinor', coalesce(sum(amount_minor) filter (where settled_at is null), 0),
        'settledMinor', coalesce(sum(amount_minor) filter (where settled_at is not null), 0),
        'todayMinor', coalesce(sum(amount_minor) filter (where created_at >= date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'), 0),
        'currency', coalesce(min(currency), 'USD'), 'trips', count(*) filter (where kind = 'trip'))
      from public.earnings_entries where driver_id = d.id),
    'cashToHandInMinor', (select coalesce(sum(amount_minor), 0) from public.cash_entries where driver_id = d.id and reconciled_at is null));
end $$;

create or replace function public.driver_offers() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver();
begin
  perform app.expire_stale();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'expiresAt', o.expires_at, 'earningsMinor', o.earnings_minor, 'currency', o.earnings_currency,
      'pickupAt', b.agreed_pickup_at, 'direction', b.direction, 'airport', a.iata, 'zone', z.name,
      'passengers', b.passengers, 'largeBags', b.large_bags, 'carryOn', b.carry_on, 'vehicleClass', b.vehicle_class,
      'estDurationMin', b.est_duration_min, 'flight', b.flight_designator) order by b.agreed_pickup_at)
    from public.booking_offers o
    join public.bookings b on b.id = o.booking_id
    join public.airports a on a.id = b.airport_id
    left join public.zones z on z.id = b.zone_id
    where o.driver_id = d.id and o.status = 'open' and o.generation = b.offer_generation and o.expires_at > now()), '[]'::jsonb);
end $$;

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

-- ---------------------------------------------------------------------------
-- Dispatch read model for the map (security_invoker: staff RLS applies)
-- ---------------------------------------------------------------------------
create or replace view public.dispatch_driver_board with (security_invoker = true) as
select d.id as driver_id, d.operator_id, d.full_name, d.on_shift, d.approval_status,
       case when d.on_shift then l.lat end as lat, case when d.on_shift then l.lng end as lng,
       case when d.on_shift then l.heading end as heading, case when d.on_shift then l.speed_mps end as speed_mps,
       case when d.on_shift then l.accuracy_m end as accuracy_m, case when d.on_shift then l.recorded_at end as recorded_at,
       v.id as vehicle_id, v.plate as vehicle_plate, v.vehicle_class,
       cur.reference as current_reference, cur.booking_id as current_booking_id, cur.trip_stage as current_stage,
       cur.agreed_pickup_at as current_pickup_at,
       case
         when not d.on_shift then 'off'
         when l.recorded_at is null or l.recorded_at < now() - interval '2 minutes' then 'stale'
         when cur.trip_stage = 'onboard' then 'onboard'
         when cur.trip_stage in ('en_route', 'at_pickup') then 'to_pickup'
         else 'free'
       end as map_status
from public.drivers d
left join public.driver_locations l on l.driver_id = d.id
left join public.vehicles v on v.id = app.driver_vehicle_at(d.id, now())
left join lateral (
  select b.reference, b.id as booking_id, s.trip_stage, b.agreed_pickup_at
    from public.assignments s join public.bookings b on b.id = s.booking_id
   where s.driver_id = d.id and s.state = 'confirmed' and s.trip_stage in ('en_route', 'at_pickup', 'onboard')
   order by b.agreed_pickup_at limit 1
) cur on true
where d.active;

grant select on public.dispatch_driver_board to authenticated;

-- Onboarding helper (service role): link a driver row to a Supabase Auth user by email.
create or replace function app.link_driver_by_email(p_driver uuid, p_email text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then raise exception 'no auth user with email % — create it in Supabase Auth first', p_email; end if;
  update public.drivers set auth_user_id = v_user where id = p_driver;
  insert into public.audit_log (operator_id, actor_kind, action, entity, entity_id, detail)
  select operator_id, 'system', 'driver.link_login', 'drivers', id, jsonb_build_object('user_id', v_user) from public.drivers where id = p_driver;
  return v_user;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function app.require_role(uuid, public.member_role[]), app.me_driver(), app.expire_stale(),
  app.allocate(public.bookings, uuid, uuid, uuid, uuid, text), app.lock_booking(uuid, int),
  app.release_active(public.bookings, uuid, text), app.link_driver_by_email(uuid, text),
  app.ineligible_reason(public.bookings, uuid, uuid) from public, anon, authenticated;

revoke all on function public.dispatch_assign(uuid, uuid, int, uuid, text), public.dispatch_offer(uuid, int, uuid[], int),
  public.dispatch_release(uuid, int, text), public.dispatch_cancel(uuid, int, text),
  public.driver_set_shift(boolean), public.driver_report_location(double precision, double precision, real, real, real, timestamptz),
  public.driver_respond_offer(uuid, boolean), public.driver_trip_progress(uuid, public.trip_stage, int),
  public.driver_me(), public.driver_offers(), public.driver_jobs() from public, anon;
grant execute on function public.dispatch_assign(uuid, uuid, int, uuid, text), public.dispatch_offer(uuid, int, uuid[], int),
  public.dispatch_release(uuid, int, text), public.dispatch_cancel(uuid, int, text),
  public.driver_set_shift(boolean), public.driver_report_location(double precision, double precision, real, real, real, timestamptz),
  public.driver_respond_offer(uuid, boolean), public.driver_trip_progress(uuid, public.trip_stage, int),
  public.driver_me(), public.driver_offers(), public.driver_jobs() to authenticated, service_role;

-- Realtime (Supabase only): push map positions, offers and booking changes to subscribed clients.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.driver_locations, public.booking_offers, public.bookings, public.assignments;
  end if;
end $$;

-- Expire holds and offers every minute where pg_cron is available (commands also expire lazily).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('soytutaxi-expire-stale', '* * * * *', 'select app.expire_stale()');
  end if;
end $$;
