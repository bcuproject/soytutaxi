-- SoyTuTaxi · The WhatsApp verify token is generated on the server when missing (nobody needs to see it):
-- stored in Vault and sent to Meta by the webhook setup step. Returns whether one was created, never the value.
create or replace function public.secrets_ensure_verify_token() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_val text;
begin
  select s.id, d.decrypted_secret into v_id, v_val
    from vault.secrets s join vault.decrypted_secrets d on d.id = s.id where s.name = 'stt.WHATSAPP_VERIFY_TOKEN';
  if coalesce(v_val, '') <> '' then return false; end if;
  if v_id is null then perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'stt.WHATSAPP_VERIFY_TOKEN', 'SoyTuTaxi integration key (generated)');
  else perform vault.update_secret(v_id, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')); end if;
  insert into public.audit_log (operator_id, actor_kind, action, entity, entity_id, detail)
  select id, 'system', 'integration.verify_token_generated', 'operators', id, '{}'::jsonb from public.operators order by created_at limit 1;
  return true;
end $$;
revoke all on function public.secrets_ensure_verify_token() from public, anon, authenticated;
grant execute on function public.secrets_ensure_verify_token() to service_role;
