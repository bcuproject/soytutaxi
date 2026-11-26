-- SoyTuTaxi · Phase 1 row-level security and transactional booking commands.
-- All passenger writes go through SECURITY DEFINER functions executed by the
-- service role from the `api` Edge Function. Staff read via RLS.

-- ---------------------------------------------------------------------------
-- Role helpers (used by RLS policies)
-- ---------------------------------------------------------------------------
create or replace function app.has_role(p_operator uuid, p_roles public.member_role[])
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.memberships m
    where m.operator_id = p_operator
      and m.user_id = auth.uid()
      and m.active
      and m.role = any (p_roles)
  );
$$;

create or replace function app.is_staff(p_operator uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select app.has_role(p_operator, array['admin','dispatcher','finance']::public.member_role[]);
$$;

create or replace function app.is_admin(p_operator uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select app.has_role(p_operator, array['admin']::public.member_role[]);
$$;

create or replace function app.current_driver_ids()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select d.id from public.drivers d
  where d.auth_user_id = auth.uid() and d.active and d.approval_status = 'approved';
$$;

grant usage on schema app to anon, authenticated, service_role;
grant execute on function app.has_role(uuid, public.member_role[]), app.is_staff(uuid), app.is_admin(uuid),
  app.current_driver_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. No anon policies: the public surface is the API only.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['operators','memberships','vehicle_classes','vehicles','drivers',
    'driver_vehicle_allocations','driver_availability','airports','zones','policies','fare_rules',
    'passengers','quotes','bookings','assignments','trip_events','exceptions','audit_log',
    'inbox_events','outbox_jobs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Operators / memberships: members read their own operator and their own memberships; admins manage.
create policy operators_member_read on public.operators for select to authenticated
  using (exists (select 1 from public.memberships m where m.operator_id = id and m.user_id = auth.uid() and m.active));
create policy memberships_self_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.is_admin(operator_id));
create policy memberships_admin_write on public.memberships for all to authenticated
  using (app.is_admin(operator_id)) with check (app.is_admin(operator_id));

-- Configuration: staff read, admin write.
do $$
declare t text;
begin
  foreach t in array array['vehicle_classes','vehicles','airports','zones','policies','fare_rules','driver_vehicle_allocations']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (app.is_staff(operator_id))', t || '_staff_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (app.is_admin(operator_id))', t || '_admin_insert', t);
    -- Policies are append-only versions: admins insert new versions, never update old ones.
    if t <> 'policies' then
      execute format('create policy %I on public.%I for update to authenticated using (app.is_admin(operator_id)) with check (app.is_admin(operator_id))', t || '_admin_update', t);
    end if;
  end loop;
end $$;

-- Drivers: staff read; admin/dispatcher manage roster; a driver reads only their own row.
create policy drivers_staff_read on public.drivers for select to authenticated using (app.is_staff(operator_id));
create policy drivers_self_read on public.drivers for select to authenticated using (auth_user_id = auth.uid());
create policy drivers_roster_write on public.drivers for all to authenticated
  using (app.has_role(operator_id, array['admin','dispatcher']::public.member_role[]))
  with check (app.has_role(operator_id, array['admin','dispatcher']::public.member_role[]));

create policy availability_staff_read on public.driver_availability for select to authenticated using (app.is_staff(operator_id));
create policy availability_self_read on public.driver_availability for select to authenticated
  using (driver_id in (select app.current_driver_ids()));

-- Operational records: staff read only. Writes go through commands.
create policy passengers_staff_read  on public.passengers  for select to authenticated using (app.is_staff(operator_id));
create policy quotes_staff_read      on public.quotes      for select to authenticated using (app.is_staff(operator_id));
create policy bookings_staff_read    on public.bookings    for select to authenticated using (app.is_staff(operator_id));
create policy trip_events_staff_read on public.trip_events for select to authenticated using (app.is_staff(operator_id));
create policy exceptions_staff_read  on public.exceptions  for select to authenticated using (app.is_staff(operator_id));
create policy audit_admin_read       on public.audit_log   for select to authenticated using (app.is_admin(operator_id));

create policy assignments_staff_read on public.assignments for select to authenticated using (app.is_staff(operator_id));
-- Drivers see only their own assignments (passenger contact is revealed by a later-phase command).
create policy assignments_self_read on public.assignments for select to authenticated
  using (driver_id in (select app.current_driver_ids()));

-- inbox_events / outbox_jobs: service role only (no policies → denied to anon/authenticated).

-- ---------------------------------------------------------------------------
-- Error helper: raise a business error the API maps to an HTTP status.
--   MESSAGE = machine code, DETAIL = http status, HINT = human text
-- ---------------------------------------------------------------------------
create or replace function app.fail(p_code text, p_status int, p_hint text default null)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = p_status::text, hint = coalesce(p_hint, p_code);
end $$;

create or replace function app.new_reference() returns text
language sql volatile set search_path = public, pg_temp as $$
  -- Crockford-ish alphabet without I, L, O, U, 0, 1 to avoid misreading over the phone.
  select 'STT-' || string_agg(substr('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + (get_byte(b, i) % 30), 1), '' order by i)
  from (select uuid_send(gen_random_uuid()) as b) r, generate_series(0, 5) as i;  -- built-in CSPRNG, no pgcrypto
$$;

-- ---------------------------------------------------------------------------
-- create_booking_from_quote: consumes a quote and inserts a booking atomically.
--   * Same idempotency key + same request hash → original result (replay = true).
--   * Same key + different payload → 409 idempotency_conflict.
--   * Quote is bound to the requesting session (session_hash) → otherwise 404.
-- ---------------------------------------------------------------------------
create or replace function public.create_booking_from_quote(
  p_operator_id        uuid,
  p_quote_id           uuid,
  p_session_hash       text,
  p_idempotency_key    text,
  p_request_hash       text,
  p_contact            jsonb,       -- {name, phone, email, locale}
  p_payment_mode       public.payment_mode,
  p_notes              text,
  p_status_token_hash  text,
  p_actor_id           uuid default null,
  p_flight_exception_reason text default null,
  p_request_id         text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q            public.quotes%rowtype;
  pol          public.policies%rowtype;
  existing     public.bookings%rowtype;
  v_passenger  uuid;
  v_booking    uuid;
  v_reference  text;
  v_locale     text;
  v_journey    jsonb;
  v_lead       int;
  v_attempt    int := 0;
  v_is_staff   boolean := false;
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    perform app.fail('idempotency_key_required', 400);
  end if;

  -- Lock the quote first so concurrent requests for it serialize here.
  select * into q from public.quotes
   where id = p_quote_id and operator_id = p_operator_id
   for update;

  -- Idempotent replay check happens *after* the lock, so a racing duplicate sees the winner's row.
  select * into existing from public.bookings
   where operator_id = p_operator_id and idempotency_key = p_idempotency_key;
  if found then
    if existing.request_hash <> p_request_hash then
      perform app.fail('idempotency_conflict', 409, 'This idempotency key was used with a different request.');
    end if;
    return jsonb_build_object('booking_id', existing.id, 'reference', existing.reference,
                              'state', existing.state, 'replay', true);
  end if;

  if q.id is null then
    perform app.fail('quote_not_found', 404);
  end if;
  if q.session_hash <> p_session_hash then
    perform app.fail('quote_not_found', 404);            -- concealed: not this requester's quote
  end if;
  if q.kind <> 'priced' then
    perform app.fail('manual_quote_required', 422, 'This journey needs a manual quote from staff.');
  end if;
  if q.consumed_booking_id is not null then
    perform app.fail('quote_already_used', 409);
  end if;
  if q.expires_at <= now() then
    perform app.fail('quote_expired', 422, 'The quote has expired. Request a new quote.');
  end if;

  select * into pol from public.policies where id = q.policy_id;
  if not (pol.config -> 'allowed_payment_modes') ? p_payment_mode::text then
    perform app.fail('payment_mode_not_allowed', 422);
  end if;

  v_lead := (pol.config ->> 'lead_time_minutes')::int;
  if q.pickup_at < now() + make_interval(mins => v_lead) then
    perform app.fail('pickup_too_soon', 422, 'Pickup is inside the minimum booking lead time.');
  end if;

  if coalesce(nullif(trim(p_contact ->> 'name'), ''), null) is null then
    perform app.fail('contact_name_required', 422);
  end if;
  if nullif(p_contact ->> 'phone', '') is null and nullif(p_contact ->> 'email', '') is null then
    perform app.fail('contact_unreachable', 422, 'A phone number or email is required.');
  end if;

  v_journey := q.journey;

  -- Airport pickups need a flight unless an authorised staff member records an exception.
  if q.direction = 'from_airport' and (v_journey -> 'flight' ->> 'designator') is null then
    if p_flight_exception_reason is null then
      perform app.fail('flight_required', 422);
    end if;
    select exists (select 1 from public.memberships m
                   where m.operator_id = p_operator_id and m.user_id = p_actor_id and m.active
                     and m.role in ('admin','dispatcher')) into v_is_staff;
    if not v_is_staff then
      perform app.fail('flight_exception_not_permitted', 403);
    end if;
  end if;

  v_locale := coalesce(nullif(p_contact ->> 'locale', ''), 'es-AR');
  if v_locale not in ('es-AR', 'en') then v_locale := 'es-AR'; end if;

  insert into public.passengers (operator_id, full_name, phone_e164, email, locale)
  values (p_operator_id, trim(p_contact ->> 'name'), nullif(p_contact ->> 'phone', ''),
          nullif(lower(p_contact ->> 'email'), ''), v_locale)
  returning id into v_passenger;

  loop
    v_attempt := v_attempt + 1;
    v_reference := app.new_reference();
    begin
      insert into public.bookings (
        operator_id, reference, source, quote_id, passenger_id, direction, airport_id, zone_id,
        pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class,
        flight_designator, flight_local_arrival_date, flight_scheduled_arrival_at,
        flight_exception_reason, flight_exception_by,
        agreed_pickup_at, est_duration_min, state, payment_mode, collection_state,
        amount_minor, currency, policy_id, locale, notes,
        status_token_hash, status_token_expires_at, idempotency_key, request_hash, created_by)
      values (
        p_operator_id, v_reference, q.source, q.id, v_passenger, q.direction, q.airport_id, q.zone_id,
        v_journey -> 'pickup', v_journey -> 'dropoff', q.passengers, q.large_bags, q.carry_on, q.vehicle_class,
        v_journey -> 'flight' ->> 'designator',
        (v_journey -> 'flight' ->> 'localArrivalDate')::date,
        (v_journey -> 'flight' ->> 'scheduledArrivalAt')::timestamptz,
        p_flight_exception_reason, case when p_flight_exception_reason is not null then p_actor_id end,
        q.pickup_at, (q.fare ->> 'estDurationMin')::int, 'needs_driver', p_payment_mode,
        case when p_payment_mode = 'prepaid' then 'awaiting_payment' else 'pending_collection' end::public.collection_state,
        q.amount_minor, q.currency, q.policy_id, v_locale, nullif(trim(p_notes), ''),
        p_status_token_hash, q.pickup_at + interval '30 days', p_idempotency_key, p_request_hash, p_actor_id)
      returning id into v_booking;
      exit;
    exception when unique_violation then
      -- Same key raced on a *different* quote: the other request won.
      if sqlerrm like '%idempotency_key%' then
        perform app.fail('idempotency_conflict', 409, 'This idempotency key was used with a different request.');
      end if;
      -- Retry only reference collisions; anything else re-raises.
      if v_attempt >= 5 or sqlerrm not like '%bookings_reference_key%' then
        raise;
      end if;
    end;
  end loop;

  update public.quotes set consumed_booking_id = v_booking, consumed_at = now() where id = q.id;

  insert into public.trip_events (operator_id, booking_id, kind, from_value, to_value, source, actor_id, payload)
  values (p_operator_id, v_booking, 'booking.created', null, 'needs_driver', q.source, p_actor_id,
          jsonb_build_object('quote_id', q.id, 'payment_mode', p_payment_mode, 'policy_version', pol.version));

  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail, request_id)
  values (p_operator_id, p_actor_id, case when p_actor_id is null then 'passenger' else 'user' end,
          'booking.create', 'bookings', v_booking,
          jsonb_build_object('reference', v_reference, 'source', q.source,
                             'flight_exception', p_flight_exception_reason is not null),
          p_request_id);

  -- Side effects are queued in the same transaction (transactional outbox).
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload) values
    (p_operator_id, 'notify.passenger.booking_received', 'booking:' || v_booking || ':received',
     jsonb_build_object('booking_id', v_booking, 'locale', v_locale)),
    (p_operator_id, 'dispatch.needs_driver', 'booking:' || v_booking || ':needs_driver:v1',
     jsonb_build_object('booking_id', v_booking));

  return jsonb_build_object('booking_id', v_booking, 'reference', v_reference,
                            'state', 'needs_driver', 'replay', false);
end $$;

-- ---------------------------------------------------------------------------
-- get_booking_status: passenger view by reference + opaque token (hash compared).
-- Returns NULL when not found or token mismatch (caller answers 404 either way).
-- ---------------------------------------------------------------------------
create or replace function public.get_booking_status(p_reference text, p_status_token_hash text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'reference',        b.reference,
    'bookingState',     b.state,
    'direction',        b.direction,
    'airport',          a.iata,
    'airportName',      a.name,
    'meetingPoint',     jsonb_build_object('es', a.meeting_point_es, 'en', a.meeting_point_en),
    'pickup',           b.pickup_place,
    'dropoff',          b.dropoff_place,
    'agreedPickupAt',   b.agreed_pickup_at,
    'proposedPickupAt', b.proposed_pickup_at,
    'passengers',       b.passengers,
    'largeBags',        b.large_bags,
    'carryOn',          b.carry_on,
    'vehicleClass',     b.vehicle_class,
    'flight',           case when b.flight_designator is null then null else
                          jsonb_build_object('designator', b.flight_designator,
                                             'localArrivalDate', b.flight_local_arrival_date) end,
    'amountMinor',      b.amount_minor,
    'currency',         b.currency,
    'paymentMode',      b.payment_mode,
    'collectionState',  b.collection_state,
    'locale',           b.locale,
    'driverAssigned',   exists (select 1 from public.assignments s where s.booking_id = b.id and s.state = 'confirmed'),
    'allowedActions',   case when b.state in ('cancelled','closed') then '[]'::jsonb
                             else '["contact_staff","request_change"]'::jsonb end,
    'createdAt',        b.created_at
  )
  from public.bookings b
  join public.airports a on a.id = b.airport_id
  where b.reference = upper(p_reference)
    and b.status_token_hash = p_status_token_hash
    and b.status_token_expires_at > now();
$$;

revoke all on function public.create_booking_from_quote(uuid, uuid, text, text, text, jsonb, public.payment_mode, text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_booking_status(text, text) from public, anon, authenticated;
grant execute on function public.create_booking_from_quote(uuid, uuid, text, text, text, jsonb, public.payment_mode, text, text, uuid, text, text) to service_role;
grant execute on function public.get_booking_status(text, text) to service_role;
revoke all on function app.fail(text, int, text) from public, anon, authenticated;
revoke all on function app.new_reference() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dispatch read model. security_invoker → RLS of the querying staff member applies.
-- ---------------------------------------------------------------------------
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
  v.id as vehicle_id, v.plate as vehicle_plate
from public.bookings b
join public.airports a   on a.id = b.airport_id
join public.passengers p on p.id = b.passenger_id
left join public.zones z on z.id = b.zone_id
left join public.assignments s on s.booking_id = b.id and s.state <> 'released'
left join public.drivers d  on d.id = s.driver_id
left join public.vehicles v on v.id = s.vehicle_id;

grant select on public.dispatch_booking_rows to authenticated;

-- ---------------------------------------------------------------------------
-- Onboarding helper: grant a role to an existing Supabase Auth user by email.
-- Service role only (run from SQL editor / CLI).
-- ---------------------------------------------------------------------------
create or replace function app.grant_role_by_email(p_operator_slug text, p_email text, p_role public.member_role)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid; v_op uuid; v_id uuid;
begin
  select id into v_op from public.operators where slug = p_operator_slug;
  if v_op is null then raise exception 'unknown operator %', p_operator_slug; end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then raise exception 'no auth user with email % — create it in Supabase Auth first', p_email; end if;
  insert into public.memberships (operator_id, user_id, role) values (v_op, v_user, p_role)
  on conflict (operator_id, user_id, role) do update set active = true
  returning id into v_id;
  insert into public.audit_log (operator_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, 'system', 'membership.grant', 'memberships', v_id, jsonb_build_object('role', p_role, 'user_id', v_user));
  return v_id;
end $$;
revoke all on function app.grant_role_by_email(text, text, public.member_role) from public, anon, authenticated;
