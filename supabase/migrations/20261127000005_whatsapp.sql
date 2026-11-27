-- SoyTuTaxi · Phase 3: WhatsApp booking chat, staff takeover, WhatsApp notifications.
-- The `whatsapp` Edge Function (service role) calls the wa_* functions below; staff use the
-- dispatch_wa_* commands and read conversations through RLS.

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------
create table public.wa_conversations (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null references public.operators(id),
  wa_id            text not null check (wa_id ~ '^[0-9]{6,20}$'),   -- sender as Meta reports it (digits)
  phone_e164       text not null,
  profile_name     text,
  kind             text not null default 'passenger' check (kind in ('passenger', 'driver')),
  driver_id        uuid references public.drivers(id),
  locale           text not null default 'es-AR' check (locale in ('es-AR', 'en')),
  step             text not null default 'menu',
  draft            jsonb not null default '{}',
  last_booking_id  uuid references public.bookings(id),
  last_inbound_at  timestamptz,                                       -- opens Meta's 24 h service window
  handoff_owner    uuid,                                              -- staff user who took over (bot paused)
  handoff_since    timestamptz,
  needs_staff      boolean not null default false,                    -- passenger asked for a person / manual quote
  version          int not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (operator_id, wa_id)
);
create index wa_conversations_recent_idx on public.wa_conversations (operator_id, updated_at desc);

create table public.wa_messages (
  id                  uuid primary key default gen_random_uuid(),
  operator_id         uuid not null references public.operators(id),
  conversation_id     uuid not null references public.wa_conversations(id),
  direction           text not null check (direction in ('in', 'out')),
  provider_message_id text unique,
  kind                text not null,                 -- text, interactive, button, location, template, …
  body                jsonb not null default '{}',   -- sanitized payload (what was sent / received)
  preview             text not null default '',
  status              text not null default 'received'
                      check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error               text,
  sent_by             uuid,                          -- staff user for manual replies; null = bot/system
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index wa_messages_conv_idx on public.wa_messages (conversation_id, created_at);

create trigger wa_conversations_touch before update on public.wa_conversations for each row execute function app.touch_updated_at();
create trigger wa_messages_touch before update on public.wa_messages for each row execute function app.touch_updated_at();

alter table public.wa_conversations enable row level security;
alter table public.wa_conversations force row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_messages force row level security;
create policy wa_conversations_staff_read on public.wa_conversations for select to authenticated using (app.is_staff(operator_id));
create policy wa_messages_staff_read on public.wa_messages for select to authenticated using (app.is_staff(operator_id));

-- Values only the database and service role may read (cron → Edge Function shared key, project URL).
create table app.private_settings (
  key   text primary key,
  value text not null
);
revoke all on app.private_settings from public, anon, authenticated;
insert into app.private_settings (key, value) values ('outbox_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Service-role commands used by the whatsapp Edge Function
-- ---------------------------------------------------------------------------
create or replace function public.wa_open_conversation(p_operator uuid, p_wa_id text, p_profile_name text)
returns public.wa_conversations language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_conversations; v_phone text := '+' || regexp_replace(p_wa_id, '\D', '', 'g'); d public.drivers;
begin
  select * into d from public.drivers
   where operator_id = p_operator and whatsapp_e164 = v_phone and whatsapp_verified_at is not null and active;
  insert into public.wa_conversations (operator_id, wa_id, phone_e164, profile_name, kind, driver_id, last_inbound_at)
  values (p_operator, regexp_replace(p_wa_id, '\D', '', 'g'), v_phone, left(p_profile_name, 120),
          case when d.id is null then 'passenger' else 'driver' end, d.id, now())
  on conflict (operator_id, wa_id) do update
    set last_inbound_at = now(),
        profile_name = coalesce(left(excluded.profile_name, 120), public.wa_conversations.profile_name),
        kind = excluded.kind, driver_id = excluded.driver_id
  returning * into c;
  return c;
end $$;

-- Optimistic save: returns the new version, or null if someone else changed the conversation.
create or replace function public.wa_save_conversation(
  p_id uuid, p_expected_version int, p_step text, p_draft jsonb, p_locale text,
  p_last_booking uuid default null, p_needs_staff boolean default null
) returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v int;
begin
  update public.wa_conversations
     set step = p_step, draft = coalesce(p_draft, '{}'::jsonb),
         locale = case when p_locale in ('es-AR', 'en') then p_locale else locale end,
         last_booking_id = coalesce(p_last_booking, last_booking_id),
         needs_staff = coalesce(p_needs_staff, needs_staff),
         version = version + 1
   where id = p_id and version = p_expected_version
  returning version into v;
  return v;
end $$;

create or replace function public.wa_record_message(
  p_conversation uuid, p_direction text, p_provider_id text, p_kind text, p_body jsonb, p_preview text,
  p_status text, p_sent_by uuid default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_op uuid;
begin
  select operator_id into v_op from public.wa_conversations where id = p_conversation;
  insert into public.wa_messages (operator_id, conversation_id, direction, provider_message_id, kind, body, preview, status, sent_by)
  values (v_op, p_conversation, p_direction, p_provider_id, p_kind, coalesce(p_body, '{}'), left(coalesce(p_preview, ''), 500), p_status, p_sent_by)
  on conflict (provider_message_id) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.wa_mark_sent(p_message uuid, p_provider_id text, p_status text, p_error text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_messages set provider_message_id = coalesce(p_provider_id, provider_message_id),
         status = p_status, error = left(p_error, 500)
   where id = p_message;
$$;

-- Delivery receipts never move a message backwards (read > delivered > sent); failures always record.
create or replace function public.wa_status_update(p_provider_id text, p_status text, p_error text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_messages m set status = p_status, error = coalesce(left(p_error, 500), m.error)
   where m.provider_message_id = p_provider_id
     and (p_status = 'failed'
          or array_position(array['queued','sent','delivered','read'], p_status)
             > coalesce(array_position(array['queued','sent','delivered','read'], m.status), 0));
$$;

-- Webhook de-duplication: true only the first time an event key is seen.
create or replace function public.wa_inbox_claim(p_operator uuid, p_event_key text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.inbox_events (operator_id, provider, event_key) values (p_operator, 'whatsapp', p_event_key)
  on conflict (provider, event_key) do nothing returning id into v_id;
  return v_id is not null;
end $$;

create or replace function public.wa_inbox_done(p_event_key text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.inbox_events set processed_at = now() where provider = 'whatsapp' and event_key = p_event_key;
$$;

-- A passenger's own bookings (verified WhatsApp sender = phone on the booking).
create or replace function public.wa_bookings_for_phone(p_operator uuid, p_phone text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x->>'pickupAt'), '[]'::jsonb) from (
    select jsonb_build_object('reference', b.reference, 'state', b.state, 'pickupAt', b.agreed_pickup_at,
             'direction', b.direction, 'airport', a.iata, 'zone', z.name, 'idempotencyKey', b.idempotency_key,
             'driverAssigned', exists (select 1 from public.assignments s where s.booking_id = b.id and s.state = 'confirmed')) as x
      from public.bookings b
      join public.passengers p on p.id = b.passenger_id
      join public.airports a on a.id = b.airport_id
      left join public.zones z on z.id = b.zone_id
     where b.operator_id = p_operator and p.phone_e164 = p_phone
       and b.agreed_pickup_at > now() - interval '12 hours' and b.state <> 'closed'
     order by b.agreed_pickup_at limit 5) t;
$$;

-- ---------------------------------------------------------------------------
-- Driver offer replies arriving by WhatsApp: same rules as the app (one shared core).
-- ---------------------------------------------------------------------------
create or replace function app.respond_offer_core(d public.drivers, p_offer uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.booking_offers; b public.bookings; v_assignment uuid;
begin
  perform app.expire_stale();
  select * into o from public.booking_offers where id = p_offer;
  if o.id is null or o.driver_id <> d.id then perform app.fail('offer_not_found', 404); end if;
  b := app.lock_booking(o.booking_id, null);
  select * into o from public.booking_offers where id = p_offer for update;

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
  return (select jsonb_build_object('outcome', 'accepted', 'assignment_id', v_assignment, 'booking_state', state, 'reference', reference)
            from public.bookings where id = b.id);
end $$;

create or replace function public.driver_respond_offer(p_offer uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return app.respond_offer_core(app.me_driver(), p_offer, p_accept);
end $$;

-- Called by the webhook for a verified driver WhatsApp number.
create or replace function public.wa_driver_respond(p_driver uuid, p_offer uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.drivers;
begin
  select * into d from public.drivers
   where id = p_driver and active and approval_status = 'approved' and whatsapp_verified_at is not null;
  if d.id is null then perform app.fail('not_a_driver', 403); end if;
  return app.respond_offer_core(d, p_offer, p_accept);
end $$;

-- ---------------------------------------------------------------------------
-- Outbox: claim notification jobs with a lease, and finish them.
-- ---------------------------------------------------------------------------
create or replace function public.wa_outbox_claim(p_limit int default 20) returns setof public.outbox_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  update public.outbox_jobs j set state = 'leased', lease_until = now() + interval '2 minutes', attempts = attempts + 1
   where j.id in (
     select id from public.outbox_jobs
      where kind like 'notify.%' and next_attempt_at <= now()
        and (state = 'pending' or (state = 'leased' and lease_until < now()))
      order by next_attempt_at limit greatest(1, least(p_limit, 100))
      for update skip locked)
  returning j.*;
end $$;

create or replace function public.wa_outbox_finish(p_job uuid, p_ok boolean, p_error text default null, p_final boolean default false)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.outbox_jobs
     set state = case when p_ok then 'done' when p_final or attempts >= 6 then 'dead' else 'pending' end::public.job_state,
         lease_until = null, last_error = left(p_error, 500),
         next_attempt_at = case when p_ok then next_attempt_at else now() + make_interval(secs => least(3600, 30 * power(2, attempts))::int) end
   where id = p_job;
$$;

-- Everything a notification needs, in one read (service role).
create or replace function public.wa_notification_context(p_kind text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_booking uuid; r jsonb;
begin
  v_booking := coalesce((p_payload ->> 'booking_id')::uuid,
                        (select booking_id from public.assignments where id = (p_payload ->> 'assignment_id')::uuid));
  select jsonb_build_object(
    'bookingId', b.id, 'reference', b.reference, 'state', b.state, 'source', b.source, 'direction', b.direction,
    'airport', a.iata, 'zone', z.name, 'pickupAt', b.agreed_pickup_at, 'flight', b.flight_designator,
    'passengers', b.passengers, 'largeBags', b.large_bags, 'amountMinor', b.amount_minor, 'currency', b.currency,
    'paymentMode', b.payment_mode, 'idempotencyKey', b.idempotency_key, 'operatorId', b.operator_id,
    'passenger', jsonb_build_object('name', p.full_name, 'phone', p.phone_e164, 'locale', p.locale,
       'lastInboundAt', (select max(c.last_inbound_at) from public.wa_conversations c where c.operator_id = b.operator_id and c.phone_e164 = p.phone_e164)),
    'driver', (select jsonb_build_object('id', d.id, 'name', d.full_name, 'phone', d.whatsapp_e164, 'verified', d.whatsapp_verified_at is not null,
                 'plate', v.plate, 'vehicle', v.description,
                 'lastInboundAt', (select max(c.last_inbound_at) from public.wa_conversations c where c.operator_id = b.operator_id and c.phone_e164 = d.whatsapp_e164))
                 from public.assignments s join public.drivers d on d.id = s.driver_id join public.vehicles v on v.id = s.vehicle_id
                where s.id = coalesce((p_payload ->> 'assignment_id')::uuid,
                                      (select id from public.assignments where booking_id = b.id and state <> 'released' limit 1))),
    'offer', (select jsonb_build_object('id', o.id, 'status', o.status, 'expiresAt', o.expires_at, 'earningsMinor', o.earnings_minor,
                 'currency', o.earnings_currency, 'generation', o.generation,
                 'driver', jsonb_build_object('id', d.id, 'name', d.full_name, 'phone', d.whatsapp_e164, 'verified', d.whatsapp_verified_at is not null,
                   'lastInboundAt', (select max(c.last_inbound_at) from public.wa_conversations c where c.operator_id = b.operator_id and c.phone_e164 = d.whatsapp_e164)))
                from public.booking_offers o join public.drivers d on d.id = o.driver_id
               where o.booking_id = b.id and o.driver_id = (p_payload ->> 'driver_id')::uuid
                 and o.generation = coalesce((p_payload ->> 'generation')::int, b.offer_generation)
               limit 1)
  ) into r
  from public.bookings b
  join public.airports a on a.id = b.airport_id
  join public.passengers p on p.id = b.passenger_id
  left join public.zones z on z.id = b.zone_id
  where b.id = v_booking;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- Staff: take over / hand back a conversation (bot pauses while a person owns it).
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_wa_takeover(p_conversation uuid, p_take boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_conversations; v_actor uuid;
begin
  select * into c from public.wa_conversations where id = p_conversation for update;
  if c.id is null then perform app.fail('conversation_not_found', 404); end if;
  v_actor := app.require_role(c.operator_id, array['admin','dispatcher']::public.member_role[]);
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


-- Conversation for an outbound notification: never touches last_inbound_at (that only moves on inbound).
create or replace function public.wa_open_conversation_for_notify(p_operator uuid, p_wa_id text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_wa text := regexp_replace(p_wa_id, '\D', '', 'g'); d public.drivers;
begin
  select id into v_id from public.wa_conversations where operator_id = p_operator and wa_id = v_wa;
  if v_id is not null then return v_id; end if;
  select * into d from public.drivers
   where operator_id = p_operator and whatsapp_e164 = '+' || v_wa and whatsapp_verified_at is not null and active;
  insert into public.wa_conversations (operator_id, wa_id, phone_e164, kind, driver_id)
  values (p_operator, v_wa, '+' || v_wa, case when d.id is null then 'passenger' else 'driver' end, d.id)
  on conflict (operator_id, wa_id) do update set updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- The outbox worker endpoint is called by pg_cron with this shared key.
create or replace function public.wa_outbox_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(length(p_key) >= 32 and p_key = (select value from app.private_settings where key = 'outbox_key'), false);
$$;

-- Every minute, ask the whatsapp function to drain notification jobs (only once functions_url is set
-- and pg_net is installed; until then jobs simply wait in the outbox).
create or replace function app.kick_whatsapp_outbox() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_key text;
begin
  select value into v_url from app.private_settings where key = 'functions_url';
  select value into v_key from app.private_settings where key = 'outbox_key';
  if v_url is null or v_key is null then return; end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then return; end if;
  if not exists (select 1 from public.outbox_jobs where kind like 'notify.%' and next_attempt_at <= now()
                   and (state = 'pending' or (state = 'leased' and lease_until < now()))) then return; end if;
  execute 'select net.http_post(url := $1, headers := $2, body := ''{}''::jsonb, timeout_milliseconds := 20000)'
    using rtrim(v_url, '/') || '/whatsapp/outbox', jsonb_build_object('content-type', 'application/json', 'x-outbox-key', v_key);
end $$;
revoke all on function app.kick_whatsapp_outbox() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soytutaxi-whatsapp-outbox', '* * * * *', 'select app.kick_whatsapp_outbox()');
  end if;
end $$;


-- Dispatch inbox: one row per chat with its latest message (RLS of the base tables applies).
create or replace view public.dispatch_wa_inbox with (security_invoker = true) as
select c.id, c.operator_id, c.wa_id, c.phone_e164, c.profile_name, c.kind, c.driver_id, c.locale, c.step,
       c.needs_staff, c.handoff_owner, c.handoff_since, c.last_inbound_at, c.updated_at, c.version,
       c.handoff_owner = auth.uid() as handled_by_me,
       (c.last_inbound_at is not null and c.last_inbound_at > now() - interval '24 hours') as window_open,
       b.reference as last_booking_reference, b.id as last_booking_id,
       m.preview as last_preview, m.direction as last_direction, m.created_at as last_message_at
  from public.wa_conversations c
  left join public.bookings b on b.id = c.last_booking_id
  left join lateral (select preview, direction, created_at from public.wa_messages x
                      where x.conversation_id = c.id order by x.created_at desc limit 1) m on true;
grant select on public.dispatch_wa_inbox to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.wa_open_conversation(uuid, text, text), public.wa_save_conversation(uuid, int, text, jsonb, text, uuid, boolean),
  public.wa_record_message(uuid, text, text, text, jsonb, text, text, uuid), public.wa_mark_sent(uuid, text, text, text),
  public.wa_status_update(text, text, text), public.wa_inbox_claim(uuid, text), public.wa_inbox_done(text),
  public.wa_bookings_for_phone(uuid, text), public.wa_driver_respond(uuid, uuid, boolean),
  public.wa_outbox_claim(int), public.wa_outbox_finish(uuid, boolean, text, boolean),
  public.wa_notification_context(text, jsonb), app.respond_offer_core(public.drivers, uuid, boolean),
  public.wa_open_conversation_for_notify(uuid, text), public.wa_outbox_key_ok(text)
  from public, anon, authenticated;
grant execute on function public.wa_open_conversation(uuid, text, text), public.wa_save_conversation(uuid, int, text, jsonb, text, uuid, boolean),
  public.wa_record_message(uuid, text, text, text, jsonb, text, text, uuid), public.wa_mark_sent(uuid, text, text, text),
  public.wa_status_update(text, text, text), public.wa_inbox_claim(uuid, text), public.wa_inbox_done(text),
  public.wa_bookings_for_phone(uuid, text), public.wa_driver_respond(uuid, uuid, boolean),
  public.wa_outbox_claim(int), public.wa_outbox_finish(uuid, boolean, text, boolean),
  public.wa_notification_context(text, jsonb), public.wa_open_conversation_for_notify(uuid, text), public.wa_outbox_key_ok(text) to service_role;
revoke all on function public.dispatch_wa_takeover(uuid, boolean) from public, anon;
grant execute on function public.dispatch_wa_takeover(uuid, boolean) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wa_conversations, public.wa_messages;
  end if;
end $$;
