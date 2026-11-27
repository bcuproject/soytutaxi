-- SoyTuTaxi · WhatsApp voice bot (LiveKit agent with Fish Audio voice on the BCU server).
--  * desk_settings.call_mode: 'desk' = calls ring the Central; 'bot' = the voice bot answers (falls back
--    to ringing the Central if the bot can't be reached).
--  * The bot never touches the database directly: it calls the whatsapp function's /voice-tool route with a
--    per-call token, and that route prices and books through the same commands as the website.

alter table public.desk_settings
  add column call_mode      text not null default 'desk' check (call_mode in ('desk', 'bot')),
  add column fish_voice_id  text check (fish_voice_id ~ '^[A-Za-z0-9_-]{8,64}$');

alter table public.wa_calls
  add column handled_by      text not null default 'desk' check (handled_by in ('desk', 'bot')),
  add column bot_room        text,
  add column wants_callback  boolean not null default false,
  add column bot_note        text,
  add column callback_done_at timestamptz;

-- Which way calls go right now (service role, read by the webhook on each call).
create or replace function public.wa_call_route(p_operator uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_build_object('mode', call_mode, 'voiceId', fish_voice_id)
                     from public.desk_settings where operator_id = p_operator),
                  jsonb_build_object('mode', 'desk', 'voiceId', null));
$$;

-- A call the voice bot answered: recorded as active and handled by the bot (no SDP kept).
create or replace function public.wa_call_bot_started(p_operator uuid, p_call_id text, p_wa_id text, p_name text, p_room text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_conversations; v_id uuid;
begin
  c := public.wa_open_conversation(p_operator, p_wa_id, p_name);
  insert into public.wa_calls (operator_id, conversation_id, provider_call_id, wa_id, phone_e164, caller_name,
                               status, handled_by, bot_room, connected_at)
  values (p_operator, c.id, p_call_id, c.wa_id, c.phone_e164, coalesce(left(p_name, 120), c.profile_name),
          'active', 'bot', p_room, now())
  on conflict (provider_call_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into public.wa_messages (operator_id, conversation_id, direction, provider_message_id, kind, preview, status)
    values (p_operator, c.id, 'in', 'call:' || p_call_id, 'call', '📞 Llamada de WhatsApp (atiende el bot)', 'received')
    on conflict (provider_message_id) do nothing;
  end if;
  return v_id;
end $$;

-- The bot asks for a person to call back (or leaves a note for the team).
create or replace function public.wa_call_bot_note(p_call_id text, p_note text, p_callback boolean)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls
     set bot_note = left(concat_ws(E'\n', bot_note, nullif(trim(p_note), '')), 1000),
         wants_callback = wants_callback or coalesce(p_callback, false)
   where provider_call_id = p_call_id;
$$;

-- Staff: choose who answers calls, and the Fish voice the bot speaks with.
create or replace function public.desk_set_call_mode(p_mode text, p_voice_id text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid; v_actor uuid;
begin
  if p_mode not in ('desk', 'bot') then perform app.fail('invalid_mode', 422); end if;
  if p_voice_id is not null and p_voice_id !~ '^[A-Za-z0-9_-]{8,64}$' then perform app.fail('invalid_voice', 422); end if;
  select m.operator_id into v_op from public.memberships m
   where m.user_id = auth.uid() and m.active and m.role in ('admin', 'dispatcher', 'agent') limit 1;
  if v_op is null then perform app.fail('forbidden', 403); end if;
  v_actor := app.require_role(v_op, array['admin','dispatcher','agent']::public.member_role[]);
  insert into public.desk_settings (operator_id, call_mode, fish_voice_id, updated_by, updated_at)
  values (v_op, p_mode, p_voice_id, v_actor, now())
  on conflict (operator_id) do update
    set call_mode = excluded.call_mode,
        fish_voice_id = coalesce(excluded.fish_voice_id, public.desk_settings.fish_voice_id),
        updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'desk.call_mode', 'desk_settings', v_op, jsonb_build_object('mode', p_mode, 'voice', p_voice_id));
  return jsonb_build_object('mode', p_mode);
end $$;

create or replace function public.desk_callback_done(p_call uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  select * into c from public.wa_calls where id = p_call;
  if c.id is null then perform app.fail('call_not_found', 404); end if;
  perform app.require_role(c.operator_id, array['admin','dispatcher','agent']::public.member_role[]);
  update public.wa_calls set callback_done_at = now() where id = c.id;
end $$;

revoke all on function public.wa_call_route(uuid), public.wa_call_bot_started(uuid, text, text, text, text),
  public.wa_call_bot_note(text, text, boolean) from public, anon, authenticated;
grant execute on function public.wa_call_route(uuid), public.wa_call_bot_started(uuid, text, text, text, text),
  public.wa_call_bot_note(text, text, boolean) to service_role;
revoke all on function public.desk_set_call_mode(text, text), public.desk_callback_done(uuid) from public, anon;
grant execute on function public.desk_set_call_mode(text, text), public.desk_callback_done(uuid) to authenticated, service_role;
