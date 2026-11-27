-- SoyTuTaxi · Passenger self-service cancellation (status page, WhatsApp, voice), day-before reminders, ratings.
-- Cancellation follows the booking's policy snapshot: full refund until free_until_hours_before, then
-- refund_percent_after. Once the driver is on the way, passengers must contact staff.

alter table public.bookings
  add column reminder_sent_at timestamptz,
  add column cancelled_by     text check (cancelled_by in ('passenger', 'staff')),
  add column cancelled_at     timestamptz;

create table public.ratings (
  booking_id  uuid primary key references public.bookings(id),
  operator_id uuid not null references public.operators(id),
  driver_id   uuid references public.drivers(id),
  score       int not null check (score between 1 and 5),
  comment     text,
  via         text not null check (via in ('web', 'whatsapp', 'voice')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index ratings_driver_idx on public.ratings (driver_id, created_at desc);
create trigger ratings_touch before update on public.ratings for each row execute function app.touch_updated_at();
alter table public.ratings enable row level security;
alter table public.ratings force row level security;
create policy ratings_staff_read on public.ratings for select to authenticated using (app.is_staff(operator_id));

-- ---------------------------------------------------------------------------
-- Cancellation
-- ---------------------------------------------------------------------------
create or replace function app.cancel_terms(b public.bookings) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare pol jsonb := app.policy_for(b); s public.assignments; v_free int; v_after int; v_pct int; v_paid bigint; v_refunded bigint;
        v_cur text; v_reason text;
begin
  select * into s from public.assignments where booking_id = b.id and state <> 'released';
  v_reason := case
    when b.state in ('cancelled', 'closed') then 'already_' || b.state::text
    when b.agreed_pickup_at <= now() then 'trip_started'
    when s.id is not null and s.trip_stage <> 'scheduled' then 'driver_on_the_way'
    else null end;
  v_free := coalesce((pol -> 'cancellation' ->> 'free_until_hours_before')::int, 24);
  v_after := coalesce((pol -> 'cancellation' ->> 'refund_percent_after')::int, 0);
  v_pct := case when b.agreed_pickup_at - now() >= make_interval(hours => v_free) then 100 else v_after end;
  select coalesce(sum(amount_minor), 0), max(currency) into v_paid, v_cur from public.payments where booking_id = b.id and is_fare_payment and status = 'approved';
  select coalesce(sum(amount_minor), 0) into v_refunded from public.refunds where booking_id = b.id and state <> 'failed';
  return jsonb_build_object(
    'allowed', v_reason is null, 'reason', v_reason, 'refundPercent', v_pct, 'freeUntilHoursBefore', v_free,
    'freeUntil', b.agreed_pickup_at - make_interval(hours => v_free),
    'paidMinor', v_paid, 'refundMinor', greatest(0, floor(v_paid * v_pct / 100.0)::bigint - v_refunded), 'currency', coalesce(v_cur, b.currency),
    'reference', b.reference, 'pickupAt', b.agreed_pickup_at, 'paymentMode', b.payment_mode, 'state', b.state);
end $$;

create or replace function app.passenger_cancel_core(p_booking uuid, p_reason text, p_via text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; t jsonb; p public.payments; r uuid;
begin
  select * into b from public.bookings where id = p_booking for update;
  t := app.cancel_terms(b);
  if not (t ->> 'allowed')::boolean then perform app.fail(t ->> 'reason', 409); end if;
  perform app.release_active(b, null, 'passenger_cancelled');
  update public.bookings set state = 'cancelled', cancelled_by = 'passenger', cancelled_at = now(), version = version + 1,
         cancelled_reason = left('Pasajero (' || p_via || ')' || coalesce(': ' || nullif(trim(p_reason), ''), ''), 300)
   where id = b.id returning * into b;
  update public.booking_offers set status = 'superseded', responded_at = now() where booking_id = b.id and status = 'open';
  insert into public.trip_events (operator_id, booking_id, kind, from_value, to_value, payload)
  values (b.operator_id, b.id, 'booking.state_changed', t ->> 'state', 'cancelled', jsonb_build_object('by', 'passenger', 'via', p_via));
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
  values (b.operator_id, 'notify.passenger.cancelled', 'cancelled:' || b.id, jsonb_build_object('booking_id', b.id)) on conflict do nothing;
  insert into public.exceptions (operator_id, booking_id, kind, severity, summary)
  values (b.operator_id, b.id, 'passenger_cancelled', 'info', b.reference || ' cancelada por el pasajero (' || p_via || ')');
  if (t ->> 'refundMinor')::bigint > 0 then
    select * into p from public.payments where booking_id = b.id and is_fare_payment and status = 'approved';
    insert into public.refunds (operator_id, booking_id, payment_id, amount_minor, currency, reason)
    values (b.operator_id, b.id, p.id, (t ->> 'refundMinor')::bigint, p.currency,
            'Cancelación del pasajero (' || (t ->> 'refundPercent') || '%)') returning id into r;
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (b.operator_id, 'payment.refund', 'refund:' || r, jsonb_build_object('refund_id', r));
  end if;
  insert into public.audit_log (operator_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, 'passenger', 'booking.cancelled_by_passenger', 'bookings', b.id, t || jsonb_build_object('via', p_via));
  return t || jsonb_build_object('cancelled', true);
end $$;

-- Status-link (token) versions, used by the public API.
create or replace function public.passenger_cancel_preview(p_reference text, p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  select * into b from public.bookings where reference = upper(p_reference) and status_token_hash = p_token_hash and status_token_expires_at > now();
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  return app.cancel_terms(b);
end $$;

create or replace function public.passenger_cancel(p_reference text, p_token_hash text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from public.bookings where reference = upper(p_reference) and status_token_hash = p_token_hash and status_token_expires_at > now();
  if v_id is null then perform app.fail('booking_not_found', 404); end if;
  return app.passenger_cancel_core(v_id, p_reason, 'web');
end $$;

-- Phone versions (WhatsApp chat and voice): the booking must belong to the number calling/writing.
create or replace function public.wa_passenger_cancel(p_operator uuid, p_phone text, p_reference text, p_confirm boolean, p_via text default 'whatsapp')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  select bk.* into b from public.bookings bk join public.passengers p on p.id = bk.passenger_id
   where bk.operator_id = p_operator and bk.reference = upper(p_reference) and p.phone_e164 = p_phone;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  if not p_confirm then return app.cancel_terms(b); end if;
  return app.passenger_cancel_core(b.id, null, case when p_via = 'voice' then 'voice' else 'whatsapp' end);
end $$;

-- ---------------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------------
create or replace function app.rate_core(b public.bookings, p_score int, p_comment text, p_via text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_driver uuid;
begin
  if b.state <> 'closed' then perform app.fail('not_completed', 409); end if;
  if p_score is null or p_score not between 1 and 5 then perform app.fail('invalid_score', 422); end if;
  select driver_id into v_driver from public.assignments where booking_id = b.id and state <> 'released' order by created_at desc limit 1;
  insert into public.ratings (booking_id, operator_id, driver_id, score, comment, via)
  values (b.id, b.operator_id, v_driver, p_score, nullif(left(trim(p_comment), 1000), ''), p_via)
  on conflict (booking_id) do update
    set score = excluded.score, comment = coalesce(excluded.comment, public.ratings.comment), via = excluded.via;
  if p_score <= 2 then
    perform app.raise_exception_once(b, 'low_rating', 'warning', b.reference || ': el pasajero calificó ' || p_score || '/5' ||
      coalesce(' · "' || left(nullif(trim(p_comment), ''), 120) || '"', ''));
    if nullif(trim(p_comment), '') is not null then
      update public.exceptions set summary = b.reference || ': el pasajero calificó ' || p_score || '/5 · "' || left(trim(p_comment), 120) || '"'
       where booking_id = b.id and kind = 'low_rating' and state <> 'resolved';
    end if;
  end if;
  return jsonb_build_object('score', p_score);
end $$;

create or replace function public.passenger_rate(p_reference text, p_token_hash text, p_score int, p_comment text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  select * into b from public.bookings where reference = upper(p_reference) and status_token_hash = p_token_hash and status_token_expires_at > now();
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  return app.rate_core(b, p_score, p_comment, 'web');
end $$;

create or replace function public.wa_rate(p_operator uuid, p_phone text, p_booking uuid, p_score int, p_comment text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  select bk.* into b from public.bookings bk join public.passengers p on p.id = bk.passenger_id
   where bk.operator_id = p_operator and bk.id = p_booking and p.phone_e164 = p_phone;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  return app.rate_core(b, p_score, p_comment, 'whatsapp');
end $$;

-- Ask for a rating 20 minutes after a completed trip.
create or replace function app.rating_on_close() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.state = 'closed' and old.state is distinct from 'closed'
     and exists (select 1 from public.assignments s where s.booking_id = new.id and s.trip_stage = 'complete') then
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload, next_attempt_at)
    values (new.operator_id, 'notify.passenger.rating', 'rating:' || new.id, jsonb_build_object('booking_id', new.id), now() + interval '20 minutes')
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger bookings_rating_request after update of state on public.bookings for each row execute function app.rating_on_close();

-- ---------------------------------------------------------------------------
-- Day-before reminders (confirmed trips). Sent between 08:00 and 21:59 Buenos Aires time, at most 24 h ahead;
-- early-morning trips are reminded the evening before.
-- ---------------------------------------------------------------------------
create or replace function app.queue_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record; v_hour int := extract(hour from p_now at time zone 'America/Argentina/Buenos_Aires');
begin
  if v_hour < 8 or v_hour >= 22 then return 0; end if;
  for r in
    select b.id, b.operator_id from public.bookings b
     where b.state = 'confirmed' and b.reminder_sent_at is null
       and b.agreed_pickup_at between p_now + interval '3 hours' and p_now + interval '24 hours'
       and (b.agreed_pickup_at - p_now > interval '14 hours'           -- the day before
            or extract(hour from b.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires') >= 10
            or v_hour >= 18)                                           -- early trips: evening before
     for update skip locked
  loop
    update public.bookings set reminder_sent_at = p_now where id = r.id;
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (r.operator_id, 'notify.passenger.reminder', 'reminder:' || r.id, jsonb_build_object('booking_id', r.id)) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-reminders', '*/15 * * * *', 'select app.queue_reminders()');
  end if;
end $$;

-- Passenger status: cancellation is now a passenger action.
create or replace function app.passenger_actions(b public.bookings) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when b.state in ('cancelled', 'closed') then
                case when b.state = 'closed' and not exists (select 1 from public.ratings r where r.booking_id = b.id)
                     then '["rate"]'::jsonb else '[]'::jsonb end
              when (app.cancel_terms(b) ->> 'allowed')::boolean then '["contact_staff","request_change","cancel"]'::jsonb
              else '["contact_staff","request_change"]'::jsonb end;
$$;


-- Passenger status now lists cancel/rate when available, plus the driver for confirmed trips (shown after
-- an accepted assignment, as the spec allows) and the passenger's rating.
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
    'allowedActions',   app.passenger_actions(b),
    'rating',           (select r.score from public.ratings r where r.booking_id = b.id),
    'createdAt',        b.created_at
  )
  from public.bookings b
  join public.airports a on a.id = b.airport_id
  where b.reference = upper(p_reference)
    and b.status_token_hash = p_status_token_hash
    and b.status_token_expires_at > now();
$$;

revoke all on function app.cancel_terms(public.bookings), app.passenger_cancel_core(uuid, text, text), app.rate_core(public.bookings, int, text, text),
  app.rating_on_close(), app.queue_reminders(timestamptz), app.passenger_actions(public.bookings) from public, anon, authenticated;
revoke all on function public.passenger_cancel_preview(text, text), public.passenger_cancel(text, text, text),
  public.wa_passenger_cancel(uuid, text, text, boolean, text), public.passenger_rate(text, text, int, text),
  public.wa_rate(uuid, text, uuid, int, text) from public, anon, authenticated;
grant execute on function public.passenger_cancel_preview(text, text), public.passenger_cancel(text, text, text),
  public.wa_passenger_cancel(uuid, text, text, boolean, text), public.passenger_rate(text, text, int, text),
  public.wa_rate(uuid, text, uuid, int, text) to service_role;
