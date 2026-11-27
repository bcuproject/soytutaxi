-- SoyTuTaxi · Driver/vehicle documents with expiry (warn, then block when enforcement is on),
-- driver pay statements with cash settlement, and the reports summary.

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table public.compliance_settings (
  operator_id uuid primary key references public.operators(id),
  enforce     boolean not null default false,   -- block assignment when a required document is missing/expired
  warn_days   int not null default 30 check (warn_days between 1 and 120),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
insert into public.compliance_settings (operator_id) select id from public.operators on conflict do nothing;
alter table public.compliance_settings enable row level security;
alter table public.compliance_settings force row level security;
create policy compliance_settings_staff_read on public.compliance_settings for select to authenticated using (app.is_staff(operator_id));

create table public.driver_documents (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id),
  driver_id   uuid references public.drivers(id),
  vehicle_id  uuid references public.vehicles(id),
  kind        text not null check (kind in ('license', 'professional_license', 'insurance', 'vtv', 'permit', 'other')),
  number      text check (length(number) <= 60),
  expires_on  date not null,
  note        text check (length(note) <= 300),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint document_owner check ((driver_id is null) <> (vehicle_id is null)),
  constraint document_kind_owner check (
    (driver_id is not null and kind in ('license', 'professional_license', 'other'))
    or (vehicle_id is not null and kind in ('insurance', 'vtv', 'permit', 'other')))
);
-- One current document of each required kind per driver/vehicle ('other' may repeat).
create unique index driver_documents_one_kind on public.driver_documents (coalesce(driver_id, vehicle_id), kind) where kind <> 'other';
create index driver_documents_expiry_idx on public.driver_documents (operator_id, expires_on);
create trigger driver_documents_touch before update on public.driver_documents for each row execute function app.touch_updated_at();
alter table public.driver_documents enable row level security;
alter table public.driver_documents force row level security;
create policy driver_documents_staff_read on public.driver_documents for select to authenticated using (app.is_staff(operator_id));

-- Required: driver licence + professional licence for drivers; insurance, VTV and the remis permit for vehicles.
create or replace function app.document_problem(p_driver uuid, p_vehicle uuid, p_on date) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with req(owner, kind) as (
    values (p_driver, 'license'), (p_driver, 'professional_license'),
           (p_vehicle, 'insurance'), (p_vehicle, 'vtv'), (p_vehicle, 'permit')
  )
  select case when d.id is null then 'documents_missing' else 'documents_expired' end || ':' || r.kind
    from req r
    left join public.driver_documents d on coalesce(d.driver_id, d.vehicle_id) = r.owner and d.kind = r.kind
   where r.owner is not null and (d.id is null or d.expires_on < p_on)
   order by (d.id is null) desc, r.kind
   limit 1;
$$;

create or replace function app.ineligible_reason(b public.bookings, p_driver uuid, p_vehicle uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers; v public.vehicles; vc public.vehicle_classes; tz text; pol jsonb; v_doc text;
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
  -- Documents must be valid on the trip date (only enforced once the operator turns it on).
  if coalesce((select enforce from public.compliance_settings where operator_id = b.operator_id), false) then
    v_doc := app.document_problem(p_driver, p_vehicle, (b.agreed_pickup_at at time zone tz)::date);
    if v_doc is not null then return split_part(v_doc, ':', 1); end if;
  end if;
  return null;
end $$;

create or replace function public.admin_set_document(p_id uuid, p_driver uuid, p_vehicle uuid, p_kind text, p_number text,
  p_expires_on date, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid; v_actor uuid; v_id uuid;
begin
  v_op := coalesce((select operator_id from public.drivers where id = p_driver), (select operator_id from public.vehicles where id = p_vehicle));
  if v_op is null then perform app.fail('not_found', 404); end if;
  v_actor := app.require_role(v_op, array['admin','dispatcher']::public.member_role[]);
  if p_expires_on is null then perform app.fail('expiry_required', 422); end if;
  if p_id is not null then
    update public.driver_documents set number = nullif(trim(p_number), ''), expires_on = p_expires_on, note = nullif(trim(p_note), '')
     where id = p_id and operator_id = v_op returning id into v_id;
    if v_id is null then perform app.fail('not_found', 404); end if;
  else
    insert into public.driver_documents (operator_id, driver_id, vehicle_id, kind, number, expires_on, note, created_by)
    values (v_op, p_driver, p_vehicle, p_kind, nullif(trim(p_number), ''), p_expires_on, nullif(trim(p_note), ''), v_actor)
    on conflict (coalesce(driver_id, vehicle_id), kind) where kind <> 'other'
      do update set number = excluded.number, expires_on = excluded.expires_on, note = excluded.note
    returning id into v_id;
  end if;
  -- A renewed document closes its expiry alert.
  update public.exceptions set state = 'resolved', resolved_at = now(), resolved_by = v_actor
   where operator_id = v_op and kind in ('document_expiring', 'document_expired') and state <> 'resolved'
     and evidence ->> 'document_id' = v_id::text and p_expires_on >= current_date;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'document.saved', 'driver_documents', v_id, jsonb_build_object('kind', p_kind, 'expires_on', p_expires_on));
  return v_id;
end $$;

create or replace function public.admin_set_compliance(p_enforce boolean, p_warn_days int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1); v_actor uuid;
begin
  v_actor := app.require_role(v_op, array['admin']::public.member_role[]);
  if p_warn_days is null or p_warn_days not between 1 and 120 then perform app.fail('invalid_settings', 422); end if;
  insert into public.compliance_settings (operator_id, enforce, warn_days, updated_by, updated_at)
  values (v_op, p_enforce, p_warn_days, v_actor, now())
  on conflict (operator_id) do update set enforce = excluded.enforce, warn_days = excluded.warn_days, updated_by = v_actor, updated_at = now();
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'compliance.updated', 'operators', v_op, jsonb_build_object('enforce', p_enforce, 'warn_days', p_warn_days));
  return jsonb_build_object('enforce', p_enforce, 'warnDays', p_warn_days);
end $$;

-- Staff view: every approved driver and allocated vehicle with each required document's status.
create or replace function public.dispatch_compliance() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1); s public.compliance_settings; v_today date;
begin
  perform app.require_role(v_op, array['admin','dispatcher','finance']::public.member_role[]);
  select * into s from public.compliance_settings where operator_id = v_op;
  v_today := (now() at time zone (select timezone from public.operators where id = v_op))::date;
  return jsonb_build_object('enforce', coalesce(s.enforce, false), 'warnDays', coalesce(s.warn_days, 30), 'today', v_today,
    'drivers', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'fullName', d.full_name, 'active', d.active and d.approval_status = 'approved',
        'vehicle', (select jsonb_build_object('id', v.id, 'plate', v.plate, 'description', v.description)
                      from public.vehicles v where v.id = app.driver_vehicle_at(d.id, now())),
        'problem', app.document_problem(d.id, app.driver_vehicle_at(d.id, now()), v_today),
        'documents', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'owner', case when x.driver_id is null then 'vehicle' else 'driver' end,
              'kind', x.kind, 'number', x.number, 'expiresOn', x.expires_on, 'note', x.note,
              'status', case when x.expires_on < v_today then 'expired' when x.expires_on < v_today + coalesce(s.warn_days, 30) then 'expiring' else 'ok' end)
              order by x.kind)
            from public.driver_documents x where x.driver_id = d.id or x.vehicle_id = app.driver_vehicle_at(d.id, now())), '[]'::jsonb))
        order by d.full_name)
      from public.drivers d where d.operator_id = v_op), '[]'::jsonb));
end $$;

-- Daily: alert on documents about to expire/expired; with enforcement, flag future trips that would now be refused.
create or replace function app.document_alerts() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record; s public.compliance_settings; v_today date; b public.bookings;
begin
  for s in select * from public.compliance_settings loop
    v_today := (now() at time zone (select timezone from public.operators where id = s.operator_id))::date;
    for r in
      select x.*, coalesce(d.full_name, v.plate) as owner_name,
             case when x.expires_on < v_today then 'document_expired' else 'document_expiring' end as alert
        from public.driver_documents x
        left join public.drivers d on d.id = x.driver_id
        left join public.vehicles v on v.id = x.vehicle_id
       where x.operator_id = s.operator_id and x.expires_on < v_today + s.warn_days
         and coalesce(d.active, v.active, true)
    loop
      if not exists (select 1 from public.exceptions e where e.operator_id = s.operator_id and e.kind = r.alert
                       and e.state <> 'resolved' and e.evidence ->> 'document_id' = r.id::text) then
        insert into public.exceptions (operator_id, kind, severity, summary, evidence)
        values (s.operator_id, r.alert, case when r.alert = 'document_expired' then 'critical' else 'warning' end::public.exception_severity,
                r.owner_name || ': ' || r.kind || case when r.alert = 'document_expired' then ' vencido el ' else ' vence el ' end || to_char(r.expires_on, 'DD/MM/YYYY'),
                jsonb_build_object('document_id', r.id, 'kind', r.kind, 'expires_on', r.expires_on));
        n := n + 1;
      end if;
    end loop;
    if s.enforce then
      for b in
        select bk.* from public.bookings bk join public.assignments a on a.booking_id = bk.id and a.state <> 'released'
         where bk.operator_id = s.operator_id and bk.state in ('held', 'confirmed') and bk.agreed_pickup_at > now()
           and app.document_problem(a.driver_id, a.vehicle_id, (bk.agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date) is not null
      loop
        perform app.raise_exception_once(b, 'assigned_driver_documents', 'critical',
          b.reference || ': el chofer asignado no tendrá la documentación vigente para el viaje');
      end loop;
    end if;
  end loop;
  return n;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-documents', '7 11 * * *', 'select app.document_alerts()');   -- 08:07 Buenos Aires
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Driver statements and settlement
-- Net = earnings (trips + adjustments) − cash the driver collected from passengers.
-- Positive: SoyTuTaxi pays the driver. Negative: the driver hands cash in.
-- ---------------------------------------------------------------------------
alter table public.cash_entries add column settlement_batch_id uuid;

create table public.settlement_batches (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id),
  driver_id       uuid not null references public.drivers(id),
  period_to       timestamptz not null,
  currency        char(3) not null,
  earnings_minor  bigint not null,
  cash_minor      bigint not null,
  net_minor       bigint not null,
  trips           int not null,
  note            text check (length(note) <= 300),
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index settlement_batches_driver_idx on public.settlement_batches (driver_id, created_at desc);
alter table public.settlement_batches enable row level security;
alter table public.settlement_batches force row level security;
create policy settlement_batches_staff_read on public.settlement_batches for select to authenticated using (app.is_staff(operator_id));
alter table public.earnings_entries add constraint earnings_settlement_fk foreign key (settlement_batch_id) references public.settlement_batches(id);
alter table public.cash_entries add constraint cash_settlement_fk foreign key (settlement_batch_id) references public.settlement_batches(id);

-- Lines for one driver: unsettled up to p_to, or the lines of one past batch.
create or replace function app.statement(p_driver uuid, p_to timestamptz, p_batch uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with lines as (
    select e.created_at as at, case when e.kind = 'trip' then 'trip' else 'adjustment' end as kind, b.reference,
           e.amount_minor as earning, 0::bigint as cash, e.currency, coalesce(e.note, '') as note
      from public.earnings_entries e left join public.bookings b on b.id = e.booking_id
     where e.driver_id = p_driver
       and (case when p_batch is null then e.settlement_batch_id is null and e.created_at < p_to else e.settlement_batch_id = p_batch end)
    union all
    select c.created_at, 'cash', b.reference, 0, c.amount_minor, c.currency, ''
      from public.cash_entries c join public.bookings b on b.id = c.booking_id
     where c.driver_id = p_driver
       and (case when p_batch is null then c.settlement_batch_id is null and c.reconciled_at is null and c.created_at < p_to else c.settlement_batch_id = p_batch end)
  )
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'reference', reference, 'earningMinor', earning,
                         'cashMinor', cash, 'currency', currency, 'note', note) order by at) from lines), '[]'::jsonb),
    'totals', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'earningsMinor', se, 'cashMinor', sc, 'netMinor', se - sc,
                         'trips', t) order by currency)
                        from (select currency, sum(earning) se, sum(cash) sc, count(*) filter (where kind = 'trip') t from lines group by currency) g), '[]'::jsonb));
$$;

-- Finance overview: unsettled balance per driver.
create or replace function public.finance_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1);
begin
  perform app.require_role(v_op, array['admin','finance']::public.member_role[]);
  return coalesce((select jsonb_agg(jsonb_build_object('driverId', d.id, 'fullName', d.full_name,
            'totals', app.statement(d.id, 'infinity', null) -> 'totals',
            'lastSettlement', (select jsonb_build_object('id', s.id, 'at', s.created_at, 'netMinor', s.net_minor, 'currency', s.currency)
                                 from public.settlement_batches s where s.driver_id = d.id order by s.created_at desc limit 1))
          order by d.full_name)
     from public.drivers d where d.operator_id = v_op), '[]'::jsonb);
end $$;

create or replace function public.finance_statement(p_driver uuid, p_to timestamptz, p_batch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers;
begin
  select * into d from public.drivers where id = p_driver;
  if d.id is null then perform app.fail('not_found', 404); end if;
  perform app.require_role(d.operator_id, array['admin','finance']::public.member_role[]);
  return app.statement(d.id, coalesce(p_to, now()), p_batch) || jsonb_build_object('driver', d.full_name,
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'at', s.created_at, 'periodTo', s.period_to, 'currency', s.currency,
        'earningsMinor', s.earnings_minor, 'cashMinor', s.cash_minor, 'netMinor', s.net_minor, 'trips', s.trips, 'note', s.note) order by s.created_at desc)
      from public.settlement_batches s where s.driver_id = d.id), '[]'::jsonb));
end $$;

create or replace function public.finance_adjustment(p_driver uuid, p_amount_minor bigint, p_currency text, p_note text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers; v_actor uuid; v_id uuid;
begin
  select * into d from public.drivers where id = p_driver;
  if d.id is null then perform app.fail('not_found', 404); end if;
  v_actor := app.require_role(d.operator_id, array['admin','finance']::public.member_role[]);
  if p_amount_minor is null or p_amount_minor = 0 then perform app.fail('invalid_amount', 422); end if;
  if coalesce(trim(p_note), '') = '' then perform app.fail('reason_required', 422); end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then perform app.fail('invalid_currency', 422); end if;
  insert into public.earnings_entries (operator_id, driver_id, kind, amount_minor, currency, note, created_by)
  values (d.operator_id, d.id, 'adjustment', p_amount_minor, p_currency, left(trim(p_note), 300), v_actor) returning id into v_id;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (d.operator_id, v_actor, 'user', 'earnings.adjusted', 'drivers', d.id, jsonb_build_object('amount', p_amount_minor, 'currency', p_currency, 'note', p_note));
  return v_id;
end $$;

-- Close everything unsettled up to p_to into one batch per currency (paid/handed in outside the system).
create or replace function public.finance_settle(p_driver uuid, p_to timestamptz, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers; v_actor uuid; t jsonb; out jsonb := '[]'::jsonb; v_id uuid; v_to timestamptz := least(coalesce(p_to, now()), now());
begin
  select * into d from public.drivers where id = p_driver for update;
  if d.id is null then perform app.fail('not_found', 404); end if;
  v_actor := app.require_role(d.operator_id, array['admin','finance']::public.member_role[]);
  for t in select jsonb_array_elements(app.statement(d.id, v_to, null) -> 'totals') loop
    insert into public.settlement_batches (operator_id, driver_id, period_to, currency, earnings_minor, cash_minor, net_minor, trips, note, created_by)
    values (d.operator_id, d.id, v_to, t ->> 'currency', (t ->> 'earningsMinor')::bigint, (t ->> 'cashMinor')::bigint,
            (t ->> 'netMinor')::bigint, (t ->> 'trips')::int, nullif(left(trim(p_note), 300), ''), v_actor) returning id into v_id;
    update public.earnings_entries set settlement_batch_id = v_id, settled_at = now()
     where driver_id = d.id and settlement_batch_id is null and created_at < v_to and currency = t ->> 'currency';
    update public.cash_entries set settlement_batch_id = v_id, reconciled_at = now()
     where driver_id = d.id and settlement_batch_id is null and reconciled_at is null and created_at < v_to and currency = t ->> 'currency';
    insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
    values (d.operator_id, v_actor, 'user', 'driver.settled', 'settlement_batches', v_id, t);
    out := out || jsonb_build_array(t || jsonb_build_object('batchId', v_id));
  end loop;
  if jsonb_array_length(out) = 0 then perform app.fail('nothing_to_settle', 409); end if;
  return out;
end $$;

-- The driver's own statement (driver app).
create or replace function public.driver_statement(p_batch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.drivers := app.me_driver(); v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if p_batch is not null and not exists (select 1 from public.settlement_batches where id = p_batch and driver_id = d.id) then
    perform app.fail('not_found', 404);
  end if;
  return app.statement(d.id, 'infinity', p_batch) || jsonb_build_object(
    'batches', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'at', s.created_at, 'currency', s.currency,
        'earningsMinor', s.earnings_minor, 'cashMinor', s.cash_minor, 'netMinor', s.net_minor, 'trips', s.trips) order by s.created_at desc)
      from (select * from public.settlement_batches where driver_id = d.id order by created_at desc limit 12) s), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'expiresOn', x.expires_on,
        'status', case when x.expires_on < v_today then 'expired' when x.expires_on < v_today + 30 then 'expiring' else 'ok' end) order by x.kind)
      from public.driver_documents x where x.driver_id = d.id or x.vehicle_id = app.driver_vehicle_at(d.id, now())), '[]'::jsonb),
    'documentProblem', app.document_problem(d.id, app.driver_vehicle_at(d.id, now()), v_today));
end $$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
create or replace function public.report_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1); tz text; v_from timestamptz; v_to timestamptz;
begin
  perform app.require_role(v_op, array['admin','dispatcher','finance']::public.member_role[]);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then perform app.fail('invalid_range', 422); end if;
  select timezone into tz from public.operators where id = v_op;
  v_from := p_from::timestamp at time zone tz;
  v_to := (p_to + 1)::timestamp at time zone tz;
  return (
    with bk as (
      select b.*, a.iata, z.name as zone_name, (b.agreed_pickup_at at time zone tz)::date as day
        from public.bookings b join public.airports a on a.id = b.airport_id left join public.zones z on z.id = b.zone_id
       where b.operator_id = v_op and b.agreed_pickup_at >= v_from and b.agreed_pickup_at < v_to
    ), done as (select * from bk where state = 'closed'),
    rt as (select r.* from public.ratings r join bk on bk.id = r.booking_id)
    select jsonb_build_object(
      'from', p_from, 'to', p_to,
      'bookings', (select count(*) from bk),
      'completed', (select count(*) from done),
      'cancelled', (select count(*) from bk where state = 'cancelled'),
      'cancelledByPassenger', (select count(*) from bk where state = 'cancelled' and cancelled_by = 'passenger'),
      'byState', (select coalesce(jsonb_object_agg(state, n), '{}'::jsonb) from (select state::text, count(*) n from bk group by state) x),
      'bySource', (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) from (select source::text, count(*) n from bk group by source) x),
      'byAirport', (select coalesce(jsonb_object_agg(iata, n), '{}'::jsonb) from (select iata, count(*) n from bk group by iata) x),
      'byDirection', (select coalesce(jsonb_object_agg(direction, n), '{}'::jsonb) from (select direction::text, count(*) n from bk group by direction) x),
      'revenue', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amountMinor', s, 'trips', n) order by currency), '[]'::jsonb)
                    from (select currency, sum(amount_minor) s, count(*) n from done where amount_minor is not null group by currency) x),
      'driverCost', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amountMinor', s) order by currency), '[]'::jsonb)
                    from (select e.currency, sum(e.amount_minor) s from public.earnings_entries e join done on done.id = e.booking_id where e.kind = 'trip' group by e.currency) x),
      'refunds', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'amountMinor', s) order by currency), '[]'::jsonb)
                    from (select r.currency, sum(r.amount_minor) s from public.refunds r join bk on bk.id = r.booking_id where r.state <> 'failed' group by r.currency) x),
      'ratings', jsonb_build_object('count', (select count(*) from rt), 'average', (select round(avg(score)::numeric, 2) from rt),
                                    'low', (select count(*) from rt where score <= 2)),
      'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'bookings', coalesce(n, 0), 'completed', coalesce(c, 0)) order by d), '[]'::jsonb)
                  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
                  left join (select day, count(*) n, count(*) filter (where state = 'closed') c from bk group by day) x on x.day = d::date),
      'topZones', (select coalesce(jsonb_agg(jsonb_build_object('zone', zone_name, 'bookings', n) order by n desc), '[]'::jsonb)
                     from (select coalesce(zone_name, '—') zone_name, count(*) n from bk group by 1 order by 2 desc limit 8) x),
      'drivers', (select coalesce(jsonb_agg(x order by (x ->> 'trips')::int desc), '[]'::jsonb) from (
                    select jsonb_build_object('driverId', d.id, 'fullName', d.full_name, 'trips', count(distinct done.id),
                      'earningsMinor', coalesce(sum(e.amount_minor), 0), 'currency', min(e.currency),
                      'rating', (select round(avg(r.score)::numeric, 2) from rt r where r.driver_id = d.id),
                      'ratings', (select count(*) from rt r where r.driver_id = d.id),
                      'noShows', (select count(*) from public.assignments s join bk on bk.id = s.booking_id where s.driver_id = d.id and s.trip_stage = 'no_show')) x
                      from public.drivers d
                      join public.assignments s on s.driver_id = d.id and s.state <> 'released' and s.trip_stage = 'complete'
                      join done on done.id = s.booking_id
                      left join public.earnings_entries e on e.assignment_id = s.id and e.kind = 'trip'
                     where d.operator_id = v_op group by d.id, d.full_name) y)
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function app.document_problem(uuid, uuid, date), app.document_alerts(), app.statement(uuid, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.admin_set_document(uuid, uuid, uuid, text, text, date, text), public.admin_set_compliance(boolean, int),
  public.dispatch_compliance(), public.finance_overview(), public.finance_statement(uuid, timestamptz, uuid),
  public.finance_adjustment(uuid, bigint, text, text), public.finance_settle(uuid, timestamptz, text),
  public.driver_statement(uuid), public.report_summary(date, date) from public, anon;
grant execute on function public.admin_set_document(uuid, uuid, uuid, text, text, date, text), public.admin_set_compliance(boolean, int),
  public.dispatch_compliance(), public.finance_overview(), public.finance_statement(uuid, timestamptz, uuid),
  public.finance_adjustment(uuid, bigint, text, text), public.finance_settle(uuid, timestamptz, text),
  public.driver_statement(uuid), public.report_summary(date, date) to authenticated;
