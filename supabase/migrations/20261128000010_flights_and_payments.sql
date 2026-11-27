-- SoyTuTaxi · Phase 4: live flight tracking with dispatcher-approved pickup changes, and Mercado Pago payments.
-- Spec §4 (payments) and §5 (flight tracking). agreed_pickup_at stays authoritative until dispatch approves.

-- ===========================================================================
-- Flight tracking
-- ===========================================================================
alter table public.bookings
  add column flight_status               text,
  add column flight_estimated_arrival_at timestamptz,
  add column flight_estimate_kind        text check (flight_estimate_kind in ('gate', 'runway_plus_taxi', 'scheduled')),
  add column flight_checked_at           timestamptz,
  add column flight_review_reason        text,
  add column pickup_dismissed_value      timestamptz;

-- Arrivals to watch now: flight known, still to happen, inside the monitoring window.
create or replace function public.flight_tracking_targets() returns table (
  booking_id uuid, flight text, local_date date, airport text, agreed_pickup_at timestamptz, checked_at timestamptz, interval_minutes int
) language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.flight_designator, b.flight_local_arrival_date, a.iata, b.agreed_pickup_at, b.flight_checked_at,
         coalesce((p.config -> 'flight_monitoring' ->> 'interval_minutes')::int, 15)
    from public.bookings b
    join public.airports a on a.id = b.airport_id
    join public.policies p on p.id = b.policy_id
   where b.direction = 'from_airport' and b.flight_designator is not null and b.flight_local_arrival_date is not null
     and b.state in ('needs_driver', 'held', 'confirmed') and not b.desk_hold
     and b.agreed_pickup_at > now() - interval '3 hours'
     and b.agreed_pickup_at < now() + make_interval(hours => coalesce((p.config -> 'flight_monitoring' ->> 'start_hours_before')::int, 24))
   order by b.agreed_pickup_at;
$$;

-- Apply one provider reading to one booking. p_kind: 'gate' (estimated/actual arrival), 'runway_plus_taxi'
-- (runway time only: taxi allowance added here) or 'scheduled'. Review cases never move the pickup.
create or replace function public.flight_tracking_apply(
  p_booking uuid, p_status text, p_arrival timestamptz, p_kind text, p_arrival_airport text, p_ambiguous boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.bookings; pol jsonb; v_iata text; v_buffer int; v_threshold int; v_taxi int;
  v_arrival timestamptz; v_proposed timestamptz; v_review text; v_outcome text := 'unchanged';
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or b.state not in ('needs_driver', 'held', 'confirmed') then return jsonb_build_object('outcome', 'skipped'); end if;
  pol := app.policy_for(b);
  select iata into v_iata from public.airports where id = b.airport_id;
  v_buffer := coalesce((pol -> 'arrival_buffer_minutes' ->> v_iata)::int, 45);
  v_threshold := coalesce((pol -> 'flight_monitoring' ->> 'change_threshold_minutes')::int, 15);
  v_taxi := coalesce((pol -> 'flight_monitoring' ->> 'taxi_to_gate_minutes')::int, 10);

  v_review := case
    when p_ambiguous then 'ambiguous_flight'
    when p_status in ('cancelled') then 'flight_cancelled'
    when p_status in ('diverted') then 'flight_diverted'
    when p_arrival_airport is not null and p_arrival_airport <> v_iata then 'different_airport'
    else null end;

  v_arrival := case when p_kind = 'runway_plus_taxi' then p_arrival + make_interval(mins => v_taxi) else p_arrival end;
  update public.bookings
     set flight_status = p_status, flight_estimated_arrival_at = v_arrival, flight_estimate_kind = p_kind,
         flight_checked_at = now(), flight_review_reason = v_review
   where id = b.id;

  if v_review is not null then
    perform app.raise_exception_once(b, 'flight_review', 'critical',
      b.reference || ': revisar vuelo ' || b.flight_designator || ' (' || replace(v_review, '_', ' ') || ')');
    return jsonb_build_object('outcome', 'review', 'reason', v_review);
  end if;
  if v_arrival is null or p_kind = 'scheduled' then return jsonb_build_object('outcome', v_outcome); end if;

  v_proposed := date_trunc('minute', v_arrival + make_interval(mins => v_buffer));
  if abs(extract(epoch from v_proposed - b.agreed_pickup_at)) / 60 < v_threshold then
    -- Back within tolerance: withdraw any open proposal.
    if b.proposed_pickup_at is not null then
      update public.bookings set proposed_pickup_at = null where id = b.id;
      update public.exceptions set state = 'resolved', resolved_at = now()
       where booking_id = b.id and kind = 'pickup_change_proposed' and state <> 'resolved';
      v_outcome := 'withdrawn';
    end if;
  elsif b.pickup_dismissed_value is not null and abs(extract(epoch from v_proposed - b.pickup_dismissed_value)) / 60 < v_threshold then
    v_outcome := 'dismissed_before';
  elsif b.proposed_pickup_at is null or abs(extract(epoch from v_proposed - b.proposed_pickup_at)) / 60 >= 5 then
    update public.bookings set proposed_pickup_at = v_proposed where id = b.id;
    update public.exceptions set state = 'resolved', resolved_at = now()
     where booking_id = b.id and kind = 'pickup_change_proposed' and state <> 'resolved';
    perform app.raise_exception_once(b, 'pickup_change_proposed', 'warning',
      b.reference || ': vuelo ' || b.flight_designator || ' llega ' ||
      to_char(v_arrival at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') || '. Búsqueda sugerida ' ||
      to_char(v_proposed at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') || ' (acordada ' ||
      to_char(b.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI') || ')');
    v_outcome := 'proposed';
  end if;
  return jsonb_build_object('outcome', v_outcome, 'proposed', v_proposed);
end $$;

-- Dispatch approves (or dismisses) the suggested pickup. Approval moves the agreed time and the assignment's
-- occupancy together; if the driver has another trip then, it fails with driver_conflict unless the
-- dispatcher chose to release the driver (the job then goes back to needs_driver).
create or replace function public.dispatch_pickup_decide(p_booking uuid, p_expected_version int, p_approve boolean,
  p_release_on_conflict boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid; s public.assignments; v_new timestamptz; v_old timestamptz; v_released boolean := false;
begin
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  if b.proposed_pickup_at is null then perform app.fail('no_proposal', 409); end if;

  if not p_approve then
    update public.bookings set pickup_dismissed_value = proposed_pickup_at, proposed_pickup_at = null, version = version + 1 where id = b.id;
    update public.exceptions set state = 'resolved', resolved_at = now(), resolved_by = v_actor
     where booking_id = b.id and kind = 'pickup_change_proposed' and state <> 'resolved';
    insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
    values (b.operator_id, v_actor, 'user', 'pickup.dismissed', 'bookings', b.id, jsonb_build_object('proposed', b.proposed_pickup_at));
    return jsonb_build_object('outcome', 'dismissed');
  end if;

  v_new := b.proposed_pickup_at; v_old := b.agreed_pickup_at;
  select * into s from public.assignments where booking_id = b.id and state <> 'released' for update;
  if s.id is not null then
    begin
      update public.assignments
         set occupied = tstzrange(v_new, v_new + (upper(occupied) - lower(occupied)), '[)'), version = version + 1
       where id = s.id;
    exception when exclusion_violation then
      if not p_release_on_conflict then perform app.fail('driver_conflict', 409, 'driver busy at the new time'); end if;
      perform app.release_active(b, v_actor, 'pickup_changed_conflict');
      v_released := true;
    end;
  end if;

  update public.bookings
     set agreed_pickup_at = v_new, proposed_pickup_at = null, pickup_dismissed_value = null, version = version + 1,
         state = case when v_released and state in ('held', 'confirmed') then 'needs_driver' else state end
   where id = b.id returning * into b;
  -- Open offers carry the old time: supersede them.
  update public.booking_offers set status = 'superseded', responded_at = now() where booking_id = b.id and status = 'open';
  update public.bookings set offer_generation = offer_generation + 1 where id = b.id;
  update public.exceptions set state = 'resolved', resolved_at = now(), resolved_by = v_actor
   where booking_id = b.id and kind = 'pickup_change_proposed' and state <> 'resolved';
  insert into public.trip_events (operator_id, booking_id, kind, actor_id, from_value, to_value, payload)
  values (b.operator_id, b.id, 'pickup.changed', v_actor, v_old::text, v_new::text, jsonb_build_object('released_driver', v_released));
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, v_actor, 'user', 'pickup.approved', 'bookings', b.id, jsonb_build_object('from', v_old, 'to', v_new, 'released', v_released));
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
  values (b.operator_id, 'notify.passenger.pickup_changed', 'pickup:' || b.id || ':' || b.version, jsonb_build_object('booking_id', b.id));
  if s.id is not null and not v_released then
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (b.operator_id, 'notify.driver.pickup_changed', 'pickup-driver:' || b.id || ':' || b.version,
            jsonb_build_object('booking_id', b.id, 'assignment_id', s.id));
  end if;
  return jsonb_build_object('outcome', 'approved', 'pickup', v_new, 'releasedDriver', v_released, 'version', b.version);
end $$;

-- ===========================================================================
-- Payments (Mercado Pago Checkout Pro)
-- ===========================================================================
create table public.payment_settings (
  operator_id     uuid primary key references public.operators(id),
  charge_currency char(3) not null default 'ARS' check (charge_currency ~ '^[A-Z]{3}$'),
  -- Units of charge_currency per 1 unit of the fare currency (e.g. ARS per USD). Required when they differ.
  fx_rates        jsonb not null default '{}',
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

create table public.payment_attempts (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators(id),
  booking_id         uuid not null references public.bookings(id),
  provider           text not null default 'mercadopago',
  state              text not null default 'created' check (state in ('created', 'pending', 'approved', 'failed', 'expired')),
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  fare_amount_minor  bigint not null,
  fare_currency      char(3) not null,
  fx_rate            numeric,
  preference_id      text,
  checkout_url       text,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index payment_attempts_booking_idx on public.payment_attempts (booking_id, created_at desc);

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  operator_id         uuid not null references public.operators(id),
  booking_id          uuid not null references public.bookings(id),
  attempt_id          uuid references public.payment_attempts(id),
  provider            text not null default 'mercadopago',
  provider_payment_id text not null unique,
  status              text not null,                -- provider status (approved, pending, rejected, refunded…)
  amount_minor        bigint not null,
  currency            char(3) not null,
  approved_at         timestamptz,
  is_fare_payment     boolean not null default false,   -- the one payment linked to the fare
  reconciliation      text not null default 'ok' check (reconciliation in ('ok', 'review', 'resolved')),
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index payments_one_fare_payment on public.payments (booking_id) where is_fare_payment;

create table public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators(id),
  booking_id         uuid not null references public.bookings(id),
  payment_id         uuid not null references public.payments(id),
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  state              text not null default 'requested' check (state in ('requested', 'pending', 'completed', 'failed')),
  reason             text not null,
  provider_refund_id text,
  error              text,
  requested_by       uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger payment_attempts_touch before update on public.payment_attempts for each row execute function app.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function app.touch_updated_at();
create trigger refunds_touch before update on public.refunds for each row execute function app.touch_updated_at();
create trigger payment_settings_touch before update on public.payment_settings for each row execute function app.touch_updated_at();

alter table public.payment_settings enable row level security;  alter table public.payment_settings force row level security;
alter table public.payment_attempts enable row level security;  alter table public.payment_attempts force row level security;
alter table public.payments enable row level security;          alter table public.payments force row level security;
alter table public.refunds enable row level security;           alter table public.refunds force row level security;
create policy payment_settings_staff_read on public.payment_settings for select to authenticated using (app.is_staff(operator_id));
create policy payment_attempts_staff_read on public.payment_attempts for select to authenticated using (app.is_staff(operator_id));
create policy payments_staff_read on public.payments for select to authenticated using (app.is_staff(operator_id));
create policy refunds_staff_read on public.refunds for select to authenticated using (app.is_staff(operator_id));

-- When a prepaid booking is reserved by a driver (held), ask the passenger to pay.
create or replace function app.payment_due_on_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.state = 'held' and old.state is distinct from 'held' and new.payment_mode = 'prepaid' and new.collection_state <> 'collected' then
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (new.operator_id, 'notify.passenger.payment_due', 'paydue:' || new.id || ':' || new.version, jsonb_build_object('booking_id', new.id))
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger bookings_payment_due after update of state on public.bookings for each row execute function app.payment_due_on_hold();

-- Checkout context for the passenger's status link (token-checked). Returns what to charge.
create or replace function public.pay_checkout_context(p_reference text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; s public.assignments; ps public.payment_settings; v_rate numeric; v_amount bigint; v_cur text; a public.payment_attempts;
begin
  select * into b from public.bookings where reference = upper(p_reference) and status_token_hash = p_token_hash;
  if b.id is null or b.status_token_expires_at < now() then perform app.fail('booking_not_found', 404); end if;
  if b.payment_mode <> 'prepaid' then perform app.fail('not_prepaid', 409); end if;
  if b.collection_state = 'collected' or exists (select 1 from public.payments where booking_id = b.id and is_fare_payment) then
    perform app.fail('already_paid', 409);
  end if;
  if b.state not in ('held', 'confirmed', 'needs_driver') then perform app.fail('not_payable', 409); end if;
  if b.amount_minor is null then perform app.fail('no_fare', 409); end if;
  select * into s from public.assignments where booking_id = b.id and state <> 'released';
  select * into ps from public.payment_settings where operator_id = b.operator_id;
  v_cur := coalesce(ps.charge_currency, 'ARS');
  if v_cur = b.currency then v_rate := 1;
  else
    v_rate := (ps.fx_rates ->> b.currency)::numeric;
    if v_rate is null or v_rate <= 0 then perform app.fail('fx_rate_missing', 409, 'set ' || b.currency || '→' || v_cur || ' rate'); end if;
  end if;
  v_amount := ceil(b.amount_minor * v_rate);
  -- Reuse a live attempt with the same amount.
  select * into a from public.payment_attempts
   where booking_id = b.id and state in ('created', 'pending') and expires_at > now() + interval '2 minutes'
     and amount_minor = v_amount and currency = v_cur and checkout_url is not null
   order by created_at desc limit 1;
  return jsonb_build_object(
    'bookingId', b.id, 'operatorId', b.operator_id, 'reference', b.reference, 'state', b.state,
    'amountMinor', v_amount, 'currency', v_cur, 'fareAmountMinor', b.amount_minor, 'fareCurrency', b.currency, 'fxRate', v_rate,
    -- Pay before the hold runs out; without a hold (no driver yet) the link lasts 24 h.
    'expiresAt', coalesce(s.hold_expires_at, now() + interval '24 hours'),
    'locale', b.locale, 'idempotencyKey', b.idempotency_key,
    'reuse', case when a.id is null then null else jsonb_build_object('attemptId', a.id, 'checkoutUrl', a.checkout_url) end);
end $$;

create or replace function public.pay_attempt_create(p_booking uuid, p_amount bigint, p_currency text, p_fare_amount bigint,
  p_fare_currency text, p_fx numeric, p_expires timestamptz) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  insert into public.payment_attempts (operator_id, booking_id, amount_minor, currency, fare_amount_minor, fare_currency, fx_rate, expires_at)
  select operator_id, id, p_amount, p_currency, p_fare_amount, p_fare_currency, p_fx, p_expires from public.bookings where id = p_booking
  returning id;
$$;

create or replace function public.pay_attempt_ready(p_attempt uuid, p_preference text, p_url text, p_ok boolean) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.payment_attempts
     set preference_id = p_preference, checkout_url = p_url, state = case when p_ok then 'created' else 'failed' end
   where id = p_attempt;
$$;

-- Record an authoritative provider payment (fetched from Mercado Pago after a verified notification).
-- Idempotent per provider payment id; status never regresses from approved.
create or replace function public.pay_record(p_attempt uuid, p_provider_payment_id text, p_status text, p_amount bigint,
  p_currency text, p_approved_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.payment_attempts; b public.bookings; p public.payments; s public.assignments; v_outcome text; v_first boolean;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if a.id is null then return jsonb_build_object('outcome', 'unknown_attempt'); end if;
  select * into b from public.bookings where id = a.booking_id for update;

  insert into public.payments (operator_id, booking_id, attempt_id, provider_payment_id, status, amount_minor, currency, approved_at)
  values (a.operator_id, a.booking_id, a.id, p_provider_payment_id, p_status, p_amount, p_currency, p_approved_at)
  on conflict (provider_payment_id) do update
    set status = case when public.payments.status = 'approved' and excluded.status in ('pending', 'in_process', 'authorized')
                      then public.payments.status else excluded.status end,
        approved_at = coalesce(public.payments.approved_at, excluded.approved_at)
  returning * into p;

  if p_status in ('rejected', 'cancelled') then
    update public.payment_attempts set state = 'failed' where id = a.id and state <> 'approved';
    return jsonb_build_object('outcome', 'failed');
  end if;
  if p_status in ('pending', 'in_process', 'authorized') then
    update public.payment_attempts set state = 'pending' where id = a.id and state in ('created', 'expired');
    return jsonb_build_object('outcome', 'pending');
  end if;
  if p_status in ('refunded', 'charged_back') then
    perform app.raise_exception_once(b, 'payment_' || p_status, 'critical', b.reference || ': pago ' || p_status || ' en Mercado Pago');
    return jsonb_build_object('outcome', p_status);
  end if;
  if p_status <> 'approved' then return jsonb_build_object('outcome', 'ignored'); end if;
  if p.is_fare_payment then return jsonb_build_object('outcome', 'already_recorded'); end if;

  update public.payment_attempts set state = 'approved' where id = a.id;

  -- Mismatched money never confirms anything.
  if p_amount <> a.amount_minor or p_currency <> a.currency then
    update public.payments set reconciliation = 'review', note = 'amount/currency mismatch' where id = p.id;
    perform app.raise_exception_once(b, 'payment_mismatch', 'critical',
      b.reference || ': pago de ' || p_amount / 100.0 || ' ' || p_currency || ' no coincide con ' || a.amount_minor / 100.0 || ' ' || a.currency);
    return jsonb_build_object('outcome', 'mismatch');
  end if;

  -- One payment is linked to the fare; any further approved payment goes to reconciliation.
  v_first := not exists (select 1 from public.payments where booking_id = b.id and is_fare_payment);
  if not v_first then
    update public.payments set reconciliation = 'review', note = 'extra payment' where id = p.id;
    perform app.raise_exception_once(b, 'payment_extra', 'critical', b.reference || ': pago adicional recibido; revisar y reembolsar');
    return jsonb_build_object('outcome', 'extra_payment');
  end if;
  update public.payments set is_fare_payment = true where id = p.id;
  update public.bookings set collection_state = 'collected', version = version + 1 where id = b.id returning * into b;

  if b.state = 'cancelled' then
    update public.payments set reconciliation = 'review', note = 'paid after cancellation' where id = p.id;
    perform app.raise_exception_once(b, 'payment_after_cancel', 'critical', b.reference || ': pago recibido de una reserva cancelada; reembolsar');
    v_outcome := 'paid_cancelled';
  elsif b.state = 'held' then
    select * into s from public.assignments where booking_id = b.id and state = 'reserving' for update;
    if s.id is not null then
      update public.assignments set state = 'confirmed', hold_expires_at = null, version = version + 1 where id = s.id;
      update public.bookings set state = 'confirmed', version = version + 1 where id = b.id;
      insert into public.trip_events (operator_id, booking_id, assignment_id, kind, from_value, to_value, payload)
      values (b.operator_id, b.id, s.id, 'booking.state_changed', 'held', 'confirmed', '{"reason":"payment_approved"}');
      insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
      values (b.operator_id, 'notify.passenger.confirmed', 'confirmed:' || b.id || ':' || s.id, jsonb_build_object('booking_id', b.id, 'assignment_id', s.id))
      on conflict do nothing;
      v_outcome := 'confirmed';
    else
      v_outcome := 'paid';
    end if;
  elsif b.state = 'needs_driver' then
    -- Late payment (hold expired): keep the money, dispatch finds a driver or refunds.
    update public.payments set reconciliation = 'review', note = 'paid without driver cover' where id = p.id;
    perform app.raise_exception_once(b, 'paid_without_cover', 'critical', b.reference || ': pagada sin chofer asignado; asignar o reembolsar');
    v_outcome := 'paid_without_cover';
  else
    v_outcome := 'paid';
  end if;
  insert into public.audit_log (operator_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, 'system', 'payment.approved', 'bookings', b.id,
          jsonb_build_object('payment', p_provider_payment_id, 'amount', p_amount, 'currency', p_currency, 'outcome', v_outcome));
  return jsonb_build_object('outcome', v_outcome, 'bookingId', b.id);
end $$;

-- Staff: refund all or part of the fare payment. Stored first, then submitted by the payments worker.
create or replace function public.dispatch_refund(p_booking uuid, p_amount_minor bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; p public.payments; v_actor uuid; v_refunded bigint; r uuid;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher','finance']::public.member_role[]);
  if coalesce(trim(p_reason), '') = '' then perform app.fail('reason_required', 422); end if;
  select * into p from public.payments where booking_id = b.id and status = 'approved'
   order by is_fare_payment asc, created_at desc limit 1;   -- extra payments first, then the fare payment
  if p.id is null then perform app.fail('no_payment', 409); end if;
  select coalesce(sum(amount_minor), 0) into v_refunded from public.refunds where payment_id = p.id and state <> 'failed';
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > p.amount_minor - v_refunded then
    perform app.fail('invalid_amount', 422, 'max ' || (p.amount_minor - v_refunded));
  end if;
  insert into public.refunds (operator_id, booking_id, payment_id, amount_minor, currency, reason, requested_by)
  values (b.operator_id, b.id, p.id, p_amount_minor, p.currency, left(p_reason, 300), v_actor) returning id into r;
  insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
  values (b.operator_id, 'payment.refund', 'refund:' || r, jsonb_build_object('refund_id', r));
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, v_actor, 'user', 'refund.requested', 'bookings', b.id, jsonb_build_object('amount', p_amount_minor, 'reason', p_reason));
  return jsonb_build_object('refundId', r);
end $$;

create or replace function public.pay_refund_context(p_refund uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('refundId', r.id, 'state', r.state, 'amountMinor', r.amount_minor, 'currency', r.currency,
                            'providerPaymentId', p.provider_payment_id, 'bookingId', r.booking_id)
    from public.refunds r join public.payments p on p.id = r.payment_id where r.id = p_refund;
$$;

create or replace function public.pay_refund_set(p_refund uuid, p_state text, p_provider_refund_id text, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.refunds; b public.bookings;
begin
  update public.refunds set state = p_state, provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id), error = left(p_error, 300)
   where id = p_refund returning * into r;
  if r.state = 'completed' then
    update public.payments set reconciliation = 'resolved' where id = r.payment_id and reconciliation = 'review';
    insert into public.outbox_jobs (operator_id, kind, dedupe_key, payload)
    values (r.operator_id, 'notify.passenger.refund', 'refund-notify:' || r.id, jsonb_build_object('booking_id', r.booking_id, 'refund_id', r.id))
    on conflict do nothing;
  elsif r.state = 'failed' then
    select * into b from public.bookings where id = r.booking_id;
    perform app.raise_exception_once(b, 'refund_failed', 'critical', b.reference || ': el reembolso falló (' || coalesce(p_error, '') || ')');
  end if;
end $$;

create or replace function public.pay_outbox_claim(p_limit int default 10) returns setof public.outbox_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update public.outbox_jobs j set state = 'leased', lease_until = now() + interval '2 minutes', attempts = attempts + 1
   where j.id in (select id from public.outbox_jobs
                   where kind like 'payment.%' and next_attempt_at <= now()
                     and (state = 'pending' or (state = 'leased' and lease_until < now()))
                   order by next_attempt_at limit greatest(1, least(p_limit, 50)) for update skip locked)
  returning j.*;
end $$;

-- Admin: currency to charge and exchange rate (e.g. {"USD": 1180} = ARS per USD).
create or replace function public.admin_set_payment_settings(p_currency text, p_fx jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid; v_actor uuid; k text;
begin
  select m.operator_id into v_op from public.memberships m where m.user_id = auth.uid() and m.active and m.role in ('admin', 'finance') limit 1;
  if v_op is null then perform app.fail('forbidden', 403); end if;
  v_actor := app.require_role(v_op, array['admin','finance']::public.member_role[]);
  if p_currency !~ '^[A-Z]{3}$' or jsonb_typeof(coalesce(p_fx, '{}')) <> 'object' then perform app.fail('invalid_settings', 422); end if;
  for k in select jsonb_object_keys(coalesce(p_fx, '{}')) loop
    if k !~ '^[A-Z]{3}$' or jsonb_typeof(p_fx -> k) <> 'number' or (p_fx ->> k)::numeric <= 0 then perform app.fail('invalid_settings', 422); end if;
  end loop;
  insert into public.payment_settings (operator_id, charge_currency, fx_rates, updated_by) values (v_op, p_currency, coalesce(p_fx, '{}'), v_actor)
  on conflict (operator_id) do update set charge_currency = excluded.charge_currency, fx_rates = excluded.fx_rates, updated_by = excluded.updated_by;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'payments.settings', 'payment_settings', v_op, jsonb_build_object('currency', p_currency, 'fx', p_fx));
  return jsonb_build_object('currency', p_currency, 'fx', p_fx);
end $$;

-- Dispatch read model: flight + payment columns appended.
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
  (select count(*) from public.booking_offers o where o.booking_id = b.id and o.status = 'open')::int as open_offers,
  b.desk_hold, b.desk_released_at, b.desk_method,
  b.flight_status, b.flight_estimated_arrival_at, b.flight_estimate_kind, b.flight_checked_at, b.flight_review_reason,
  (select coalesce(sum(x.amount_minor), 0) from public.payments x where x.booking_id = b.id and x.is_fare_payment)::bigint as paid_minor,
  (select x.currency from public.payments x where x.booking_id = b.id and x.is_fare_payment) as paid_currency,
  (select coalesce(sum(r.amount_minor), 0) from public.refunds r where r.booking_id = b.id and r.state = 'completed')::bigint as refunded_minor,
  exists (select 1 from public.payments x where x.booking_id = b.id and x.reconciliation = 'review') as payment_review
from public.bookings b
join public.airports a   on a.id = b.airport_id
join public.passengers p on p.id = b.passenger_id
left join public.zones z on z.id = b.zone_id
left join public.assignments s on s.booking_id = b.id and s.state <> 'released'
left join public.drivers d  on d.id = s.driver_id
left join public.vehicles v on v.id = s.vehicle_id;
grant select on public.dispatch_booking_rows to authenticated;

-- ===========================================================================
-- Workers (pg_cron → Edge Functions via pg_net, same shared key as the WhatsApp outbox)
-- ===========================================================================
create or replace function app.kick_function(p_path text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_key text;
begin
  select value into v_url from app.private_settings where key = 'functions_url';
  select value into v_key from app.private_settings where key = 'outbox_key';
  if v_url is null or v_key is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := ''{}''::jsonb, timeout_milliseconds := 20000)'
    using rtrim(v_url, '/') || p_path, jsonb_build_object('content-type', 'application/json', 'x-outbox-key', v_key);
end $$;

create or replace function app.kick_payments() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.outbox_jobs where kind like 'payment.%' and next_attempt_at <= now()
               and (state = 'pending' or (state = 'leased' and lease_until < now()))) then
    perform app.kick_function('/payments/outbox');
  end if;
end $$;

create or replace function app.kick_flight_tracking() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.flight_tracking_targets()) then perform app.kick_function('/flights/track'); end if;
end $$;

-- Payment attempts past their expiry.
create or replace function app.expire_payment_attempts() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.payment_attempts set state = 'expired' where state in ('created', 'pending') and expires_at < now();
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-payments', '* * * * *', 'select app.kick_payments(); select app.expire_payment_attempts();');
    perform cron.schedule('soytutaxi-flight-tracking', '*/5 * * * *', 'select app.kick_flight_tracking()');
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payments, public.refunds;
  end if;
end $$;

-- ===========================================================================
-- Grants
-- ===========================================================================
revoke all on function public.flight_tracking_targets(), public.flight_tracking_apply(uuid, text, timestamptz, text, text, boolean),
  public.pay_checkout_context(text, text), public.pay_attempt_create(uuid, bigint, text, bigint, text, numeric, timestamptz),
  public.pay_attempt_ready(uuid, text, text, boolean), public.pay_record(uuid, text, text, bigint, text, timestamptz),
  public.pay_refund_context(uuid), public.pay_refund_set(uuid, text, text, text), public.pay_outbox_claim(int),
  app.kick_function(text), app.kick_payments(), app.kick_flight_tracking(), app.expire_payment_attempts(), app.payment_due_on_hold()
  from public, anon, authenticated;
grant execute on function public.flight_tracking_targets(), public.flight_tracking_apply(uuid, text, timestamptz, text, text, boolean),
  public.pay_checkout_context(text, text), public.pay_attempt_create(uuid, bigint, text, bigint, text, numeric, timestamptz),
  public.pay_attempt_ready(uuid, text, text, boolean), public.pay_record(uuid, text, text, bigint, text, timestamptz),
  public.pay_refund_context(uuid), public.pay_refund_set(uuid, text, text, text), public.pay_outbox_claim(int) to service_role;
revoke all on function public.dispatch_pickup_decide(uuid, int, boolean, boolean), public.dispatch_refund(uuid, bigint, text),
  public.admin_set_payment_settings(text, jsonb) from public, anon;
grant execute on function public.dispatch_pickup_decide(uuid, int, boolean, boolean), public.dispatch_refund(uuid, bigint, text),
  public.admin_set_payment_settings(text, jsonb) to authenticated, service_role;
