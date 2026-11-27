-- SoyTuTaxi · Hotel/agency accounts with monthly invoices, and live transfer of Sofía's calls to a person.

-- ===========================================================================
-- Accounts
-- ===========================================================================
create table public.accounts (
  id                 uuid primary key default gen_random_uuid(),
  operator_id        uuid not null references public.operators(id),
  name               text not null check (length(trim(name)) between 2 and 120),
  kind               text not null default 'hotel' check (kind in ('hotel', 'agency', 'company')),
  tax_id             text check (length(tax_id) <= 20),          -- CUIT
  email              text check (length(email) <= 200),
  phone              text check (length(phone) <= 30),
  address            text check (length(address) <= 200),
  discount_percent   numeric(5,2) not null default 0 check (discount_percent between 0 and 50),
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 120),
  active             boolean not null default true,
  notes              text check (length(notes) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (operator_id, name)
);
create trigger accounts_touch before update on public.accounts for each row execute function app.touch_updated_at();
alter table public.accounts enable row level security;
alter table public.accounts force row level security;
create policy accounts_staff_read on public.accounts for select to authenticated using (app.is_staff(operator_id));

alter table public.bookings
  add column account_id  uuid references public.accounts(id),
  add column account_ref text check (length(account_ref) <= 80);    -- guest / room / voucher, printed on the invoice
create index bookings_account_idx on public.bookings (account_id, agreed_pickup_at) where account_id is not null;

create sequence public.account_invoice_seq;

create table public.account_invoices (
  id             uuid primary key default gen_random_uuid(),
  operator_id    uuid not null references public.operators(id),
  account_id     uuid not null references public.accounts(id),
  number         text not null unique,
  period_start   date not null,
  period_end     date not null,
  currency       char(3) not null,
  subtotal_minor bigint not null,
  discount_minor bigint not null default 0,
  total_minor    bigint not null,
  state          text not null default 'draft' check (state in ('draft', 'issued', 'paid', 'void')),
  due_on         date,
  issued_at      timestamptz,
  paid_at        timestamptz,
  voided_at      timestamptz,
  note           text check (length(note) <= 300),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index account_invoices_account_idx on public.account_invoices (account_id, period_start desc);
create trigger account_invoices_touch before update on public.account_invoices for each row execute function app.touch_updated_at();
alter table public.account_invoices enable row level security;
alter table public.account_invoices force row level security;
create policy account_invoices_staff_read on public.account_invoices for select to authenticated using (app.is_staff(operator_id));

create table public.account_invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.account_invoices(id),
  booking_id   uuid not null references public.bookings(id),
  reference    text not null,
  pickup_at    timestamptz not null,
  description  text not null,
  amount_minor bigint not null
);
create index account_invoice_lines_booking_idx on public.account_invoice_lines (booking_id);
alter table public.account_invoice_lines enable row level security;
alter table public.account_invoice_lines force row level security;
create policy account_invoice_lines_staff_read on public.account_invoice_lines for select to authenticated
  using (exists (select 1 from public.account_invoices i where i.id = invoice_id and app.is_staff(i.operator_id)));

create or replace function public.admin_save_account(p_id uuid, p_name text, p_kind text, p_tax_id text, p_email text, p_phone text,
  p_address text, p_discount numeric, p_terms int, p_active boolean, p_notes text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1); v_actor uuid; v_id uuid;
begin
  v_actor := app.require_role(v_op, array['admin','finance']::public.member_role[]);
  if coalesce(length(trim(p_name)), 0) < 2 then perform app.fail('name_required', 422); end if;
  if p_id is null then
    insert into public.accounts (operator_id, name, kind, tax_id, email, phone, address, discount_percent, payment_terms_days, active, notes)
    values (v_op, trim(p_name), coalesce(p_kind, 'hotel'), nullif(trim(p_tax_id), ''), nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
            nullif(trim(p_address), ''), coalesce(p_discount, 0), coalesce(p_terms, 30), coalesce(p_active, true), nullif(trim(p_notes), ''))
    returning id into v_id;
  else
    update public.accounts set name = trim(p_name), kind = coalesce(p_kind, kind), tax_id = nullif(trim(p_tax_id), ''), email = nullif(trim(p_email), ''),
           phone = nullif(trim(p_phone), ''), address = nullif(trim(p_address), ''), discount_percent = coalesce(p_discount, 0),
           payment_terms_days = coalesce(p_terms, 30), active = coalesce(p_active, true), notes = nullif(trim(p_notes), '')
     where id = p_id and operator_id = v_op returning id into v_id;
    if v_id is null then perform app.fail('not_found', 404); end if;
  end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'account.saved', 'accounts', v_id, jsonb_build_object('name', p_name, 'discount', p_discount));
  return v_id;
exception when unique_violation then
  perform app.fail('account_exists', 409);
end $$;

-- Put a booking on (or take it off) an account. Desk, dispatch and admin.
create or replace function public.dispatch_set_account(p_booking uuid, p_expected_version int, p_account uuid, p_ref text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher','agent']::public.member_role[]);
  if b.version <> p_expected_version then perform app.fail('stale_version', 409); end if;
  if b.state in ('closed', 'cancelled') then perform app.fail('booking_closed', 409); end if;
  if b.collection_state = 'collected' then perform app.fail('already_paid', 409); end if;
  if exists (select 1 from public.account_invoice_lines l join public.account_invoices i on i.id = l.invoice_id
              where l.booking_id = b.id and i.state <> 'void') then perform app.fail('already_invoiced', 409); end if;
  if p_account is not null then
    if not exists (select 1 from public.accounts where id = p_account and operator_id = b.operator_id and active) then
      perform app.fail('account_not_found', 404);
    end if;
    update public.bookings set account_id = p_account, account_ref = nullif(left(trim(p_ref), 80), ''),
           payment_mode = 'account', collection_state = 'not_applicable', version = version + 1
     where id = b.id returning * into b;
  else
    update public.bookings set account_id = null, account_ref = null,
           payment_mode = case when payment_mode = 'account' then 'pay_on_pickup_cash' else payment_mode end,
           collection_state = case when payment_mode = 'account' then 'pending_collection' else collection_state end,
           version = version + 1
     where id = b.id returning * into b;
  end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, v_actor, 'user', 'booking.account_set', 'bookings', b.id, jsonb_build_object('account', p_account, 'ref', p_ref));
  return jsonb_build_object('version', b.version, 'paymentMode', b.payment_mode);
end $$;

-- Billable = finished account trips not on a live (non-void) invoice.
create or replace function app.unbilled(p_account uuid, p_from timestamptz, p_to timestamptz)
returns setof public.bookings language sql stable security definer set search_path = public, pg_temp as $$
  select b.* from public.bookings b
   where b.account_id = p_account and b.state = 'closed' and b.amount_minor is not null
     and b.agreed_pickup_at >= p_from and b.agreed_pickup_at < p_to
     and not exists (select 1 from public.account_invoice_lines l join public.account_invoices i on i.id = l.invoice_id
                      where l.booking_id = b.id and i.state <> 'void');
$$;

create or replace function public.finance_accounts() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1);
begin
  perform app.require_role(v_op, array['admin','finance','dispatcher','agent']::public.member_role[]);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'name', a.name, 'kind', a.kind, 'taxId', a.tax_id, 'email', a.email, 'phone', a.phone, 'address', a.address,
      'discountPercent', a.discount_percent, 'paymentTermsDays', a.payment_terms_days, 'active', a.active, 'notes', a.notes,
      'unbilled', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amountMinor', s, 'trips', n))
                    from (select currency, sum(amount_minor) s, count(*) n from app.unbilled(a.id, '-infinity', 'infinity') group by currency) u), '[]'::jsonb),
      'upcoming', (select count(*) from public.bookings b where b.account_id = a.id and b.state not in ('closed', 'cancelled')),
      'outstanding', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'amountMinor', s))
                    from (select currency, sum(total_minor) s from public.account_invoices where account_id = a.id and state = 'issued' group by currency) o), '[]'::jsonb),
      'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'periodStart', i.period_start, 'periodEnd', i.period_end,
                    'currency', i.currency, 'totalMinor', i.total_minor, 'state', i.state, 'dueOn', i.due_on,
                    'overdue', i.state = 'issued' and i.due_on < current_date) order by i.period_start desc, i.number desc)
                    from (select * from public.account_invoices where account_id = a.id order by period_start desc limit 24) i), '[]'::jsonb))
    order by a.active desc, a.name)
    from public.accounts a where a.operator_id = v_op), '[]'::jsonb);
end $$;

-- Draft invoice(s) for one account and month (one per currency). Lines are a snapshot of each trip.
create or replace function app.invoice_generate(p_account uuid, p_month date, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.accounts; tz text; v_start date := date_trunc('month', p_month)::date; v_end date; cur text; v_id uuid; v_sub bigint;
        out jsonb := '[]'::jsonb;
begin
  select * into a from public.accounts where id = p_account for update;
  if a.id is null then perform app.fail('account_not_found', 404); end if;
  select timezone into tz from public.operators where id = a.operator_id;
  v_end := (v_start + interval '1 month')::date;
  for cur in select distinct currency from app.unbilled(a.id, v_start::timestamp at time zone tz, v_end::timestamp at time zone tz) loop
    select sum(amount_minor) into v_sub from app.unbilled(a.id, v_start::timestamp at time zone tz, v_end::timestamp at time zone tz) where currency = cur;
    insert into public.account_invoices (operator_id, account_id, number, period_start, period_end, currency, subtotal_minor, discount_minor, total_minor, created_by)
    values (a.operator_id, a.id, 'CTA-' || to_char(v_start, 'YYYYMM') || '-' || lpad(nextval('public.account_invoice_seq')::text, 4, '0'),
            v_start, v_end - 1, cur, v_sub, floor(v_sub * a.discount_percent / 100)::bigint, v_sub - floor(v_sub * a.discount_percent / 100)::bigint, p_actor)
    returning id into v_id;
    insert into public.account_invoice_lines (invoice_id, booking_id, reference, pickup_at, description, amount_minor)
    select v_id, b.id, b.reference, b.agreed_pickup_at,
           left(case when b.direction = 'from_airport' then ap.iata || ' → ' || coalesce(z.name, '') else coalesce(z.name, '') || ' → ' || ap.iata end
                || ' · ' || p.full_name || coalesce(' · ' || b.account_ref, ''), 200),
           b.amount_minor
      from app.unbilled(a.id, v_start::timestamp at time zone tz, v_end::timestamp at time zone tz) b
      join public.airports ap on ap.id = b.airport_id join public.passengers p on p.id = b.passenger_id
      left join public.zones z on z.id = b.zone_id
     where b.currency = cur;
    out := out || jsonb_build_array(v_id);
  end loop;
  return out;
end $$;

create or replace function public.finance_invoice_generate(p_account uuid, p_month date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select operator_id from public.accounts where id = p_account); v_actor uuid; r jsonb;
begin
  if v_op is null then perform app.fail('account_not_found', 404); end if;
  v_actor := app.require_role(v_op, array['admin','finance']::public.member_role[]);
  r := app.invoice_generate(p_account, coalesce(p_month, current_date), v_actor);
  if jsonb_array_length(r) = 0 then perform app.fail('nothing_to_invoice', 409); end if;
  return r;
end $$;

create or replace function public.finance_invoice_state(p_invoice uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.account_invoices; v_actor uuid; v_terms int;
begin
  select * into i from public.account_invoices where id = p_invoice for update;
  if i.id is null then perform app.fail('not_found', 404); end if;
  v_actor := app.require_role(i.operator_id, array['admin','finance']::public.member_role[]);
  select payment_terms_days into v_terms from public.accounts where id = i.account_id;
  if p_state = 'issued' and i.state = 'draft' then
    update public.account_invoices set state = 'issued', issued_at = now(), due_on = current_date + v_terms where id = i.id returning * into i;
  elsif p_state = 'paid' and i.state = 'issued' then
    update public.account_invoices set state = 'paid', paid_at = now() where id = i.id returning * into i;
    update public.bookings set collection_state = 'collected'
     where id in (select booking_id from public.account_invoice_lines where invoice_id = i.id);
  elsif p_state = 'void' and i.state in ('draft', 'issued') then
    update public.account_invoices set state = 'void', voided_at = now() where id = i.id returning * into i;
  else
    perform app.fail('invalid_transition', 409);
  end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (i.operator_id, v_actor, 'user', 'invoice.' || p_state, 'account_invoices', i.id, jsonb_build_object('number', i.number, 'total', i.total_minor));
  return jsonb_build_object('state', i.state, 'dueOn', i.due_on);
end $$;

create or replace function public.finance_invoice(p_invoice uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare i public.account_invoices; a public.accounts;
begin
  select * into i from public.account_invoices where id = p_invoice;
  if i.id is null then perform app.fail('not_found', 404); end if;
  perform app.require_role(i.operator_id, array['admin','finance']::public.member_role[]);
  select * into a from public.accounts where id = i.account_id;
  return jsonb_build_object('id', i.id, 'number', i.number, 'periodStart', i.period_start, 'periodEnd', i.period_end, 'currency', i.currency,
    'subtotalMinor', i.subtotal_minor, 'discountMinor', i.discount_minor, 'totalMinor', i.total_minor, 'state', i.state,
    'issuedAt', i.issued_at, 'dueOn', i.due_on, 'paidAt', i.paid_at,
    'operator', (select name from public.operators where id = i.operator_id),
    'account', jsonb_build_object('name', a.name, 'taxId', a.tax_id, 'email', a.email, 'address', a.address, 'discountPercent', a.discount_percent),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('reference', l.reference, 'pickupAt', l.pickup_at, 'description', l.description,
                         'amountMinor', l.amount_minor) order by l.pickup_at) from public.account_invoice_lines l where l.invoice_id = i.id), '[]'::jsonb));
end $$;

-- 1st of each month (Buenos Aires): drafts for last month for every active account.
create or replace function app.monthly_invoices() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare a record; n int := 0; r jsonb;
begin
  for a in select id from public.accounts where active loop
    r := app.invoice_generate(a.id, (date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') - interval '1 month')::date, null);
    n := n + jsonb_array_length(r);
  end loop;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-account-invoices', '17 9 1 * *', 'select app.monthly_invoices()');   -- 06:17 Buenos Aires
  end if;
end $$;

-- Dispatch rows show the account.
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
  exists (select 1 from public.payments x where x.booking_id = b.id and x.reconciliation = 'review') as payment_review,
  b.account_id, ac.name as account_name, b.account_ref
from public.bookings b
join public.airports a   on a.id = b.airport_id
join public.passengers p on p.id = b.passenger_id
left join public.zones z on z.id = b.zone_id
left join public.assignments s on s.booking_id = b.id and s.state <> 'released'
left join public.drivers d  on d.id = s.driver_id
left join public.vehicles v on v.id = s.vehicle_id
left join public.accounts ac on ac.id = b.account_id;
grant select on public.dispatch_booking_rows to authenticated;

-- ===========================================================================
-- Live transfer: Sofía asks for a person; a desk agent joins the call's LiveKit room from the browser.
-- ===========================================================================
alter table public.wa_calls
  add column transfer_requested_at timestamptz,
  add column transfer_reason       text check (length(transfer_reason) <= 300),
  add column transfer_taken_by     uuid,
  add column transfer_taken_at     timestamptz,
  add column transfer_failed_at    timestamptz;

create or replace function public.wa_call_transfer_request(p_call_id text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  update public.wa_calls set transfer_requested_at = coalesce(transfer_requested_at, now()), transfer_reason = left(nullif(trim(p_reason), ''), 300),
         transfer_failed_at = null
   where provider_call_id = p_call_id and handled_by = 'bot' and status not in ('ended', 'missed', 'rejected', 'failed')
     and transfer_taken_at is null
  returning * into c;
  return jsonb_build_object('ok', c.id is not null);
end $$;

create or replace function public.wa_call_transfer_failed(p_call_id text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls set transfer_failed_at = now(), wants_callback = true,
         bot_note = left(concat_ws(' · ', bot_note, 'Pidió hablar con una persona; nadie atendió a tiempo' || coalesce(': ' || transfer_reason, '')), 1000)
   where provider_call_id = p_call_id and transfer_taken_at is null;
$$;

-- Service role (the Edge Function checks the user is desk staff first).
create or replace function public.wa_call_transfer_claim(p_call uuid, p_user uuid) returns public.wa_calls
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  update public.wa_calls set transfer_taken_by = p_user, transfer_taken_at = now(), answered_by = p_user
   where id = p_call and handled_by = 'bot' and transfer_requested_at is not null and transfer_taken_at is null
     and transfer_failed_at is null and status not in ('ended', 'missed', 'rejected', 'failed') and bot_room is not null
  returning * into c;
  return c;
end $$;

revoke all on function app.unbilled(uuid, timestamptz, timestamptz), app.invoice_generate(uuid, date, uuid), app.monthly_invoices()
  from public, anon, authenticated;
revoke all on function public.admin_save_account(uuid, text, text, text, text, text, text, numeric, int, boolean, text),
  public.dispatch_set_account(uuid, int, uuid, text), public.finance_accounts(), public.finance_invoice_generate(uuid, date),
  public.finance_invoice_state(uuid, text), public.finance_invoice(uuid) from public, anon;
grant execute on function public.admin_save_account(uuid, text, text, text, text, text, text, numeric, int, boolean, text),
  public.dispatch_set_account(uuid, int, uuid, text), public.finance_accounts(), public.finance_invoice_generate(uuid, date),
  public.finance_invoice_state(uuid, text), public.finance_invoice(uuid) to authenticated;
revoke all on function public.wa_call_transfer_request(text, text), public.wa_call_transfer_failed(text), public.wa_call_transfer_claim(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.wa_call_transfer_request(text, text), public.wa_call_transfer_failed(text), public.wa_call_transfer_claim(uuid, uuid)
  to service_role;
