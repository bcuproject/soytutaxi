-- SoyTuTaxi · Integration keys entered by an admin on /conexion, stored encrypted in Supabase Vault.
-- Write-only for people: nobody can read a value back through the app. Only the server functions read them
-- (service role). Edge Function secrets set in the Supabase dashboard still win over these.
-- Also: one-time setup codes to create the first admin account from the same page.

create table app.secret_names (name text primary key, label text not null);
insert into app.secret_names (name, label) values
  ('WHATSAPP_ACCESS_TOKEN', 'WhatsApp · token de acceso (System User)'),
  ('WHATSAPP_APP_SECRET',   'WhatsApp · App secret'),
  ('WHATSAPP_VERIFY_TOKEN', 'WhatsApp · verify token'),
  ('LIVEKIT_URL',           'LiveKit · URL'),
  ('LIVEKIT_API_KEY',       'LiveKit · API key'),
  ('LIVEKIT_API_SECRET',    'LiveKit · API secret'),
  ('AI_API_KEY',            'IA · API key'),
  ('FLIGHTS_API_KEY',       'Vuelos · API key (AeroDataBox)'),
  ('FLIGHTS_PROVIDER',      'Vuelos · proveedor (apimarket o rapidapi)'),
  ('MP_ACCESS_TOKEN',       'Mercado Pago · access token'),
  ('MP_WEBHOOK_SECRET',     'Mercado Pago · webhook secret'),
  ('MP_COLLECTOR_ID',       'Mercado Pago · collector ID');

-- Admin: save keys (empty values are skipped; names in p_clear are removed). Returns only which keys are set.
create or replace function public.admin_set_secrets(p_values jsonb, p_clear text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1); v_actor uuid; k text; v text; v_id uuid;
        changed text[] := '{}';
begin
  v_actor := app.require_role(v_op, array['admin']::public.member_role[]);
  for k, v in select key, value from jsonb_each_text(coalesce(p_values, '{}'::jsonb)) loop
    if not exists (select 1 from app.secret_names where name = k) then perform app.fail('unknown_secret', 422); end if;
    v := trim(v);
    continue when v is null or v = '';
    if length(v) > 4000 then perform app.fail('value_too_long', 422); end if;
    select id into v_id from vault.secrets where name = 'stt.' || k;
    if v_id is null then perform vault.create_secret(v, 'stt.' || k, 'SoyTuTaxi integration key');
    else perform vault.update_secret(v_id, v); end if;
    changed := changed || k;
  end loop;
  foreach k in array coalesce(p_clear, '{}') loop
    if not exists (select 1 from app.secret_names where name = k) then perform app.fail('unknown_secret', 422); end if;
    select id into v_id from vault.secrets where name = 'stt.' || k;
    if v_id is not null then perform vault.update_secret(v_id, '', null, 'SoyTuTaxi integration key (cleared)'); end if;
    changed := changed || ('-' || k);
  end loop;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', 'integration.keys_saved', 'operators', v_op, jsonb_build_object('keys', changed));   -- names only, never values
  return public.admin_secret_status();
end $$;

create or replace function public.admin_secret_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := (select id from public.operators order by created_at limit 1);
begin
  perform app.require_role(v_op, array['admin']::public.member_role[]);
  return (select jsonb_agg(jsonb_build_object('name', n.name, 'label', n.label,
            'set', coalesce(d.decrypted_secret, '') <> '', 'updatedAt', s.updated_at) order by n.name)
            from app.secret_names n
            left join vault.secrets s on s.name = 'stt.' || n.name
            left join vault.decrypted_secrets d on d.id = s.id);
end $$;

-- Server functions only.
create or replace function public.secrets_for_functions() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(substr(d.name, 5), d.decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets d
   where d.name like 'stt.%' and coalesce(d.decrypted_secret, '') <> ''
     and substr(d.name, 5) in (select name from app.secret_names);
$$;

-- One-time setup codes (only the hash is stored) to create the first admin from /conexion.
create table app.setup_codes (
  code_hash  text primary key,
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_email text
);
create or replace function public.setup_code_redeem(p_code_hash text, p_email text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean;
begin
  update app.setup_codes set used_at = now(), used_email = lower(trim(p_email))
   where code_hash = p_code_hash and used_at is null and expires_at > now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.setup_code_valid(p_code_hash text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from app.setup_codes where code_hash = p_code_hash and used_at is null and expires_at > now());
$$;

-- After the account exists: make it admin of the operator (service role, behind a valid setup code).
create or replace function public.setup_grant_admin(p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.grant_role_by_email((select slug from public.operators order by created_at limit 1), lower(trim(p_email)), 'admin');
end $$;

revoke all on function public.admin_set_secrets(jsonb, text[]), public.admin_secret_status() from public, anon;
grant execute on function public.admin_set_secrets(jsonb, text[]), public.admin_secret_status() to authenticated;
revoke all on function public.secrets_for_functions(), public.setup_code_redeem(text, text), public.setup_code_valid(text), public.setup_grant_admin(text) from public, anon, authenticated;
grant execute on function public.secrets_for_functions(), public.setup_code_redeem(text, text), public.setup_code_valid(text), public.setup_grant_admin(text) to service_role;
