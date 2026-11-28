-- SoyTuTaxi · WhatsApp connection settings saved by the setup screen (non-secret: number ID, account ID,
-- approved template names). The access token and app secret stay in Edge Function secrets only.
create table public.wa_runtime (
  operator_id     uuid primary key references public.operators(id),
  phone_number_id text check (phone_number_id ~ '^[0-9]{5,30}$'),
  waba_id         text check (waba_id ~ '^[0-9]{5,30}$'),
  templates       jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
alter table public.wa_runtime enable row level security;
alter table public.wa_runtime force row level security;   -- server only

create or replace function public.wa_runtime_get() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_build_object('phoneNumberId', phone_number_id, 'wabaId', waba_id, 'templates', templates, 'updatedAt', updated_at)
                     from public.wa_runtime order by updated_at desc limit 1), '{}'::jsonb);
$$;

create or replace function public.wa_runtime_set(p_phone text, p_waba text, p_templates jsonb, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1);
begin
  insert into public.wa_runtime (operator_id, phone_number_id, waba_id, templates, updated_by)
  values (v_op, p_phone, p_waba, coalesce(p_templates, '{}'::jsonb), p_user)
  on conflict (operator_id) do update set
    phone_number_id = coalesce(excluded.phone_number_id, public.wa_runtime.phone_number_id),
    waba_id = coalesce(excluded.waba_id, public.wa_runtime.waba_id),
    templates = public.wa_runtime.templates || coalesce(p_templates, '{}'::jsonb),
    updated_at = now(), updated_by = p_user;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, p_user, case when p_user is null then 'system' else 'user' end, 'whatsapp.connection_saved', 'operators', v_op,
          jsonb_build_object('phone_number_id', p_phone, 'waba_id', p_waba, 'templates', p_templates));
  return public.wa_runtime_get();
end $$;

revoke all on function public.wa_runtime_get(), public.wa_runtime_set(text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.wa_runtime_get(), public.wa_runtime_set(text, text, jsonb, uuid) to service_role;
