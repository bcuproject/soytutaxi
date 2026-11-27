-- SoyTuTaxi · Central de reservas (booking desk) and WhatsApp voice calls.
--  * Desk mode per operator: 'auto' = new bookings go straight to dispatch; 'manual' = they wait in the
--    desk queue (desk_hold) until an agent sends them, choosing how: automatic offers, job board, or manual.
--  * Held bookings are invisible to the board and to automatic escalation.
--  * WhatsApp calls (Cloud API Calling) are stored in wa_calls; agents answer them in the browser.

-- ---------------------------------------------------------------------------
-- Staff now includes booking-desk agents (read access through RLS).
-- ---------------------------------------------------------------------------
create or replace function app.is_staff(p_operator uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select app.has_role(p_operator, array['admin','dispatcher','finance','agent']::public.member_role[]);
$$;

-- ---------------------------------------------------------------------------
-- Desk queue
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column desk_hold        boolean not null default false,
  add column desk_released_at timestamptz,
  add column desk_released_by uuid,
  add column desk_method      text check (desk_method in ('auto', 'board', 'manual'));
create index bookings_desk_hold_idx on public.bookings (operator_id) where desk_hold;

create table public.desk_settings (
  operator_id uuid primary key references public.operators(id),
  mode        text not null default 'auto' check (mode in ('auto', 'manual')),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
alter table public.desk_settings enable row level security;
alter table public.desk_settings force row level security;
create policy desk_settings_staff_read on public.desk_settings for select to authenticated using (app.is_staff(operator_id));

-- In manual mode every new booking (any channel) starts in the desk queue.
create or replace function app.desk_hold_on_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.desk_settings s where s.operator_id = new.operator_id and s.mode = 'manual') then
    new.desk_hold := true;
  end if;
  return new;
end $$;
create trigger bookings_desk_hold before insert on public.bookings for each row execute function app.desk_hold_on_insert();

-- Board and escalation ignore bookings still at the desk.
create or replace function app.on_board(b public.bookings) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select b.state = 'needs_driver' and not b.board_hold and not b.desk_hold and b.board_closed_at is null
         and b.agreed_pickup_at > now() + make_interval(hours => app.board_cutoff_hours(b));
$$;

create or replace function app.escalate_board() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; n int := 0; v_max int; v_first boolean;
begin
  perform app.expire_stale();
  for b in
    select * from public.bookings bk
     where bk.state = 'needs_driver' and not bk.board_hold and not bk.desk_hold and bk.agreed_pickup_at > now()
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

-- Switch the desk between automatic and manual hand-off.
create or replace function public.desk_set_mode(p_mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid; v_actor uuid;
begin
  if p_mode not in ('auto', 'manual') then perform app.fail('invalid_mode', 422); end if;
  select m.operator_id into v_op from public.memberships m
   where m.user_id = auth.uid() and m.active and m.role in ('admin', 'dispatcher', 'agent') limit 1;
  if v_op is null then perform app.fail('forbidden', 403); end if;
  v_actor := app.require_role(v_op, array['admin','dispatcher','agent']::public.member_role[]);
  insert into public.desk_settings (operator_id, mode, updated_by, updated_at) values (v_op, p_mode, v_actor, now())
  on conflict (operator_id) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'desk.mode', 'desk_settings', v_op, jsonb_build_object('mode', p_mode));
  return jsonb_build_object('mode', p_mode);
end $$;

-- Send a booking from the desk to dispatch, choosing how drivers get it:
--   auto   → offered now to the nearest eligible drivers (rounds continue automatically)
--   board  → listed on the job board (urgent ones still escalate nearest-first)
--   manual → kept off the board; a dispatcher assigns it
create or replace function public.desk_release(p_booking uuid, p_expected_version int, p_method text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_actor uuid; v_note text;
begin
  if p_method not in ('auto', 'board', 'manual') then perform app.fail('invalid_method', 422); end if;
  select operator_id into b.operator_id from public.bookings where id = p_booking;
  if b.operator_id is null then perform app.fail('booking_not_found', 404); end if;
  v_actor := app.require_role(b.operator_id, array['admin','dispatcher','agent']::public.member_role[]);
  b := app.lock_booking(p_booking, p_expected_version);
  if not b.desk_hold then perform app.fail('already_sent', 409); end if;

  update public.bookings
     set desk_hold = false, desk_released_at = now(), desk_released_by = v_actor, desk_method = p_method,
         board_hold = (p_method = 'manual'), version = version + 1
   where id = b.id returning * into b;

  if b.state = 'needs_driver' and p_method = 'auto' then
    update public.bookings set auto_dispatch = true, auto_rounds = 0, board_closed_at = coalesce(board_closed_at, now())
     where id = b.id returning * into b;
    begin
      perform app.offer_core(b, v_actor, null, null, false);
      update public.bookings set auto_rounds = 1 where id = b.id returning * into b;
    exception when others then
      if sqlerrm = 'no_eligible_drivers' then
        v_note := 'no_eligible_drivers';   -- escalation keeps trying and alerts dispatch
        perform app.raise_exception_once(b, 'no_driver_available', 'critical', 'No hay choferes libres y habilitados para ' || b.reference);
      else
        raise;
      end if;
    end;
  end if;

  insert into public.trip_events (operator_id, booking_id, kind, actor_id, payload)
  values (b.operator_id, b.id, 'desk.released', v_actor, jsonb_build_object('method', p_method));
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (b.operator_id, v_actor, 'user', 'booking.desk_release', 'bookings', b.id, jsonb_build_object('method', p_method));
  return jsonb_build_object('method', p_method, 'version', b.version, 'on_board', app.on_board(b), 'note', v_note);
end $$;

-- Dispatch read model: desk columns appended (existing columns keep their order).
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
  b.desk_hold, b.desk_released_at, b.desk_method
from public.bookings b
join public.airports a   on a.id = b.airport_id
join public.passengers p on p.id = b.passenger_id
left join public.zones z on z.id = b.zone_id
left join public.assignments s on s.booking_id = b.id and s.state <> 'released'
left join public.drivers d  on d.id = s.driver_id
left join public.vehicles v on v.id = s.vehicle_id;
grant select on public.dispatch_booking_rows to authenticated;

-- Agents can take over WhatsApp chats too.
create or replace function public.dispatch_wa_takeover(p_conversation uuid, p_take boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_conversations; v_actor uuid;
begin
  select * into c from public.wa_conversations where id = p_conversation for update;
  if c.id is null then perform app.fail('conversation_not_found', 404); end if;
  v_actor := app.require_role(c.operator_id, array['admin','dispatcher','agent']::public.member_role[]);
  if p_take then
    update public.wa_conversations set handoff_owner = v_actor, handoff_since = now(), version = version + 1
     where id = c.id returning * into c;
  else
    update public.wa_conversations set handoff_owner = null, handoff_since = null, needs_staff = false,
           step = 'menu', draft = '{}'::jsonb, version = version + 1
     where id = c.id returning * into c;
  end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id)
  values (c.operator_id, v_actor, 'user', case when p_take then 'wa.takeover' else 'wa.release' end, 'wa_conversations', c.id);
  return jsonb_build_object('handoff_owner', c.handoff_owner, 'version', c.version);
end $$;

-- ---------------------------------------------------------------------------
-- WhatsApp voice calls
-- ---------------------------------------------------------------------------
create table public.wa_calls (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null references public.operators(id),
  conversation_id  uuid references public.wa_conversations(id),
  provider_call_id text not null unique,
  direction        text not null default 'in' check (direction in ('in', 'out')),
  wa_id            text not null,
  phone_e164       text not null,
  caller_name      text,
  status           text not null default 'ringing'
                   check (status in ('ringing', 'answering', 'active', 'ended', 'missed', 'rejected', 'failed')),
  offer_sdp        text,                       -- WebRTC offer from Meta (needed by the answering browser)
  answered_by      uuid,
  booking_id       uuid references public.bookings(id),
  error            text,
  started_at       timestamptz not null default now(),
  connected_at     timestamptz,
  ended_at         timestamptz,
  duration_s       int,
  updated_at       timestamptz not null default now()
);
create index wa_calls_recent_idx on public.wa_calls (operator_id, started_at desc);
create trigger wa_calls_touch before update on public.wa_calls for each row execute function app.touch_updated_at();
alter table public.wa_calls enable row level security;
alter table public.wa_calls force row level security;
create policy wa_calls_staff_read on public.wa_calls for select to authenticated using (app.is_staff(operator_id));

-- Incoming call (webhook 'connect'). A call also opens the 24 h messaging window.
create or replace function public.wa_call_incoming(p_operator uuid, p_call_id text, p_wa_id text, p_name text, p_sdp text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_conversations; v_id uuid;
begin
  c := public.wa_open_conversation(p_operator, p_wa_id, p_name);
  insert into public.wa_calls (operator_id, conversation_id, provider_call_id, wa_id, phone_e164, caller_name, offer_sdp)
  values (p_operator, c.id, p_call_id, c.wa_id, c.phone_e164, coalesce(left(p_name, 120), c.profile_name), p_sdp)
  on conflict (provider_call_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into public.wa_messages (operator_id, conversation_id, direction, provider_message_id, kind, preview, status)
    values (p_operator, c.id, 'in', 'call:' || p_call_id, 'call', '📞 Llamada de WhatsApp', 'received')
    on conflict (provider_message_id) do nothing;
  end if;
  return v_id;
end $$;

-- Call ended (webhook 'terminate'): never answered → missed.
create or replace function public.wa_call_terminated(p_call_id text, p_status text, p_duration int, p_error text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls
     set status = case when status in ('rejected', 'ended') then status
                       when p_status = 'FAILED' then 'failed'
                       when connected_at is null then 'missed' else 'ended' end,
         ended_at = coalesce(ended_at, now()), duration_s = coalesce(p_duration, duration_s),
         error = coalesce(left(p_error, 300), error), offer_sdp = null
   where provider_call_id = p_call_id;
  update public.wa_messages set preview = (
           select case when c.connected_at is null then '📞 Llamada perdida'
                       else '📞 Llamada · ' || coalesce(c.duration_s, 0) / 60 || ' min ' || coalesce(c.duration_s, 0) % 60 || ' s' end
             from public.wa_calls c where c.provider_call_id = p_call_id)
   where provider_message_id = 'call:' || p_call_id;
$$;

-- One agent answers: atomic claim of a ringing call.
create or replace function public.wa_call_claim(p_call uuid, p_user uuid) returns public.wa_calls
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  update public.wa_calls set status = 'answering', answered_by = p_user
   where id = p_call and status = 'ringing' returning * into c;
  return c;
end $$;

create or replace function public.wa_call_set(p_call uuid, p_status text, p_error text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls
     set status = p_status,
         connected_at = case when p_status = 'active' then coalesce(connected_at, now()) else connected_at end,
         ended_at = case when p_status in ('ended', 'rejected', 'failed') then coalesce(ended_at, now()) else ended_at end,
         offer_sdp = case when p_status in ('ended', 'rejected', 'failed') then null else offer_sdp end,
         error = coalesce(left(p_error, 300), error)
   where id = p_call;
$$;

-- Ringing calls nobody touched for 2 minutes are closed (Meta gives up after ~60 s).
create or replace function app.expire_calls() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls set status = 'missed', ended_at = now(), offer_sdp = null
   where status in ('ringing', 'answering') and started_at < now() - interval '2 minutes';
$$;

-- Link a call to the booking the agent created during it.
create or replace function public.desk_call_link_booking(p_call uuid, p_reference text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  select * into c from public.wa_calls where id = p_call;
  if c.id is null then perform app.fail('call_not_found', 404); end if;
  perform app.require_role(c.operator_id, array['admin','dispatcher','agent']::public.member_role[]);
  update public.wa_calls set booking_id = (select id from public.bookings where operator_id = c.operator_id and reference = p_reference)
   where id = c.id;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-expire-calls', '* * * * *', 'select app.expire_calls()');
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wa_calls, public.desk_settings;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.wa_call_incoming(uuid, text, text, text, text), public.wa_call_terminated(text, text, int, text),
  public.wa_call_claim(uuid, uuid), public.wa_call_set(uuid, text, text), app.expire_calls(), app.desk_hold_on_insert()
  from public, anon, authenticated;
grant execute on function public.wa_call_incoming(uuid, text, text, text, text), public.wa_call_terminated(text, text, int, text),
  public.wa_call_claim(uuid, uuid), public.wa_call_set(uuid, text, text) to service_role;
revoke all on function public.desk_set_mode(text), public.desk_release(uuid, int, text), public.desk_call_link_booking(uuid, text) from public, anon;
grant execute on function public.desk_set_mode(text), public.desk_release(uuid, int, text), public.desk_call_link_booking(uuid, text)
  to authenticated, service_role;
