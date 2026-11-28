-- SoyTuTaxi · WhatsApp calls: "Central first, Sofía as back-up".
--  * desk_settings.call_overflow: with call_mode 'desk', a call goes to the voice bot (Sofía) when every agent is
--    already on a call, or when nobody answers within call_ring_seconds. call_mode 'bot' still means Sofía takes
--    every call; 'desk' without overflow means calls only ring the Central.
--  * Additive only: new columns and functions; existing ones keep their signatures.

alter table public.desk_settings
  add column if not exists call_overflow     boolean not null default false,
  add column if not exists call_ring_seconds int     not null default 20 check (call_ring_seconds between 8 and 60);

-- Which way calls go right now (service role, read by the webhook on each call).
create or replace function public.wa_call_route(p_operator uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_build_object('mode', call_mode, 'voiceId', fish_voice_id,
                                             'overflow', call_overflow, 'ringSeconds', call_ring_seconds)
                     from public.desk_settings where operator_id = p_operator),
                  jsonb_build_object('mode', 'desk', 'voiceId', null, 'overflow', false, 'ringSeconds', 20));
$$;

-- Is someone at the Central already talking to a caller?
create or replace function public.wa_desk_busy(p_operator uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.wa_calls
                  where operator_id = p_operator and handled_by = 'desk' and status in ('answering', 'active')
                    and started_at > now() - interval '3 hours');
$$;

-- Hand a still-ringing desk call to the bot. Returns the offer to accept, or nothing if someone answered meanwhile.
create or replace function public.wa_call_overflow_claim(p_call_id text, p_room text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.wa_calls;
begin
  update public.wa_calls
     set status = 'active', handled_by = 'bot', bot_room = p_room, connected_at = now()
   where provider_call_id = p_call_id and status = 'ringing' and offer_sdp is not null
  returning * into c;
  if c.id is null then return null; end if;
  update public.wa_messages set preview = '📞 Llamada de WhatsApp (la atendió Sofía)'
   where provider_message_id = 'call:' || p_call_id;
  return jsonb_build_object('waId', c.wa_id, 'name', c.caller_name, 'sdp', c.offer_sdp);
end $$;

-- The bot could not take it after all: ring the Central again (if the caller is still there).
create or replace function public.wa_call_overflow_release(p_call_id text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.wa_calls set status = 'ringing', handled_by = 'desk', bot_room = null, connected_at = null
   where provider_call_id = p_call_id and handled_by = 'bot' and status = 'active' and ended_at is null;
$$;

-- Staff: who answers calls. p_mode 'desk' | 'smart' (Central first, Sofía back-up) | 'bot'.
create or replace function public.desk_set_call_routing(p_mode text, p_voice_id text default null, p_ring_seconds int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid; v_actor uuid; v_ring int;
begin
  if p_mode not in ('desk', 'smart', 'bot') then perform app.fail('invalid_mode', 422); end if;
  if p_voice_id is not null and p_voice_id !~ '^[A-Za-z0-9_-]{8,64}$' then perform app.fail('invalid_voice', 422); end if;
  if p_ring_seconds is not null and p_ring_seconds not between 8 and 60 then perform app.fail('invalid_ring_seconds', 422); end if;
  select m.operator_id into v_op from public.memberships m
   where m.user_id = auth.uid() and m.active and m.role in ('admin', 'dispatcher', 'agent') limit 1;
  if v_op is null then perform app.fail('forbidden', 403); end if;
  v_actor := app.require_role(v_op, array['admin','dispatcher','agent']::public.member_role[]);
  insert into public.desk_settings (operator_id, call_mode, call_overflow, call_ring_seconds, fish_voice_id, updated_by, updated_at)
  values (v_op, case when p_mode = 'bot' then 'bot' else 'desk' end, p_mode = 'smart', coalesce(p_ring_seconds, 20), p_voice_id, v_actor, now())
  on conflict (operator_id) do update
    set call_mode = excluded.call_mode,
        call_overflow = excluded.call_overflow,
        call_ring_seconds = coalesce(p_ring_seconds, public.desk_settings.call_ring_seconds),
        fish_voice_id = coalesce(excluded.fish_voice_id, public.desk_settings.fish_voice_id),
        updated_by = excluded.updated_by, updated_at = now()
  returning call_ring_seconds into v_ring;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'desk.call_mode', 'desk_settings', v_op,
          jsonb_build_object('mode', p_mode, 'voice', p_voice_id, 'ringSeconds', v_ring));
  return jsonb_build_object('mode', p_mode, 'ringSeconds', v_ring);
end $$;

revoke all on function public.wa_desk_busy(uuid), public.wa_call_overflow_claim(text, text), public.wa_call_overflow_release(text)
  from public, anon, authenticated;
grant execute on function public.wa_desk_busy(uuid), public.wa_call_overflow_claim(text, text), public.wa_call_overflow_release(text)
  to service_role;
revoke all on function public.desk_set_call_routing(text, text, int) from public, anon;
grant execute on function public.desk_set_call_routing(text, text, int) to authenticated, service_role;
