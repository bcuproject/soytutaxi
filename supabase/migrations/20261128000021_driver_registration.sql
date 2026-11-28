-- SoyTuTaxi · driver registration.
--  * Dispatch adds a driver (+ vehicle) and gets a one-time invitation link; the driver opens it and sets their own
--    email and password (the server creates the login; nobody else ever sees the password).
--  * Drivers can also apply themselves ("Quiero ser chofer"): they stay 'pending' until dispatch approves them.
--  Additive only.

alter table public.drivers
  add column if not exists email       text,
  add column if not exists source      text not null default 'staff' check (source in ('staff', 'signup')),
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

create table if not exists app.driver_invites (
  token_hash text primary key,                       -- sha256 of the token in the link; the token itself is never stored
  driver_id  uuid not null references public.drivers(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists driver_invites_driver_idx on app.driver_invites (driver_id);

create or replace function app.staff_operator(p_roles public.member_role[] default array['admin','dispatcher']::public.member_role[])
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  select m.operator_id into v from public.memberships m
   where m.user_id = auth.uid() and m.active and m.role = any(p_roles) limit 1;
  if v is null then perform app.fail('forbidden', 403); end if;
  return v;
end $$;

create or replace function app.e164(p text) returns text language sql immutable as $$
  select case when p is null or btrim(p) = '' then null else '+' || regexp_replace(p, '\D', '', 'g') end;
$$;

-- Drivers with their vehicle, login and review state (dispatch screen).
create or replace function public.admin_drivers() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_op uuid := app.staff_operator();
begin
  return coalesce((select jsonb_agg(x order by (x->>'status') = 'pending' desc, x->>'fullName') from (
    select jsonb_build_object(
      'id', d.id, 'fullName', d.full_name, 'whatsapp', d.whatsapp_e164, 'email', d.email,
      'status', d.approval_status, 'active', d.active, 'source', d.source, 'hasLogin', d.auth_user_id is not null,
      'whatsappVerified', d.whatsapp_verified_at is not null, 'createdAt', d.created_at,
      'reviewedAt', d.reviewed_at, 'reviewNote', d.review_note,
      'inviteOpen', exists (select 1 from app.driver_invites i where i.driver_id = d.id and i.used_at is null and i.expires_at > now()),
      'vehicle', (select jsonb_build_object('id', v.id, 'vehicleClass', v.vehicle_class, 'plate', v.plate, 'description', v.description,
                                            'maxPassengers', v.max_passengers, 'maxLargeBags', v.max_large_bags)
                    from public.driver_vehicle_allocations a join public.vehicles v on v.id = a.vehicle_id
                   where a.driver_id = d.id and a.active and a.period @> now() order by lower(a.period) desc limit 1)) as x
    from public.drivers d where d.operator_id = v_op) s), '[]'::jsonb);
end $$;

-- Shared by dispatch and sign-up: put this vehicle on this driver from now on (closing any earlier allocation).
create or replace function app.assign_vehicle(p_op uuid, p_driver uuid, p_class text, p_plate text, p_desc text,
                                              p_max_pax int, p_max_bags int) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_vehicle uuid; v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '\s', '', 'g'));
begin
  if v_plate !~ '^[A-Z0-9-]{5,10}$' then perform app.fail('invalid_plate', 422); end if;
  if not exists (select 1 from public.vehicle_classes where operator_id = p_op and code = p_class) then perform app.fail('invalid_vehicle_class', 422); end if;
  insert into public.vehicles (operator_id, vehicle_class, plate, description, max_passengers, max_large_bags)
  values (p_op, p_class, v_plate, nullif(btrim(p_desc), ''), p_max_pax, p_max_bags)
  on conflict (operator_id, plate) do update
    set vehicle_class = excluded.vehicle_class, description = coalesce(excluded.description, public.vehicles.description),
        max_passengers = excluded.max_passengers, max_large_bags = excluded.max_large_bags, active = true, updated_at = now()
  returning id into v_vehicle;
  -- Someone else is driving it right now?
  if exists (select 1 from public.driver_vehicle_allocations a
              where a.vehicle_id = v_vehicle and a.active and a.driver_id <> p_driver and a.period @> now()) then
    perform app.fail('vehicle_in_use', 409);
  end if;
  if not exists (select 1 from public.driver_vehicle_allocations a
                  where a.vehicle_id = v_vehicle and a.driver_id = p_driver and a.active and a.period @> now()) then
    update public.driver_vehicle_allocations set period = tstzrange(lower(period), now(), '[)'), updated_at = now()
     where driver_id = p_driver and active and period @> now() and lower(period) < now();
    insert into public.driver_vehicle_allocations (operator_id, driver_id, vehicle_id, period)
    values (p_op, p_driver, v_vehicle, tstzrange(now(), null, '[)'));
  end if;
  return v_vehicle;
end $$;

-- Dispatch: create or edit a driver and their vehicle. New drivers added by dispatch are approved straight away.
create or replace function public.admin_save_driver(
  p_driver uuid, p_full_name text, p_whatsapp text, p_vehicle_class text, p_plate text,
  p_vehicle_desc text default null, p_max_passengers int default null, p_max_large_bags int default null,
  p_active boolean default true
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := app.staff_operator(); v_actor uuid := auth.uid(); v_id uuid; v_phone text := app.e164(p_whatsapp);
begin
  if coalesce(length(btrim(p_full_name)), 0) < 3 then perform app.fail('invalid_name', 422); end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then perform app.fail('invalid_phone', 422); end if;
  if exists (select 1 from public.drivers where operator_id = v_op and whatsapp_e164 = v_phone and id is distinct from p_driver) then
    perform app.fail('phone_in_use', 409);
  end if;
  if p_driver is null then
    insert into public.drivers (operator_id, full_name, whatsapp_e164, approval_status, active, source, reviewed_by, reviewed_at)
    values (v_op, btrim(p_full_name), v_phone, 'approved', true, 'staff', v_actor, now()) returning id into v_id;
  else
    update public.drivers
       set full_name = btrim(p_full_name),
           whatsapp_verified_at = case when whatsapp_e164 is distinct from v_phone then null else whatsapp_verified_at end,
           whatsapp_e164 = v_phone, active = coalesce(p_active, active), updated_at = now()
     where id = p_driver and operator_id = v_op returning id into v_id;
    if v_id is null then perform app.fail('driver_not_found', 404); end if;
  end if;
  perform app.assign_vehicle(v_op, v_id, p_vehicle_class, p_plate, p_vehicle_desc, p_max_passengers, p_max_large_bags);
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, v_actor, 'user', case when p_driver is null then 'driver.create' else 'driver.update' end, 'driver', v_id,
          jsonb_build_object('name', btrim(p_full_name), 'plate', p_plate, 'class', p_vehicle_class));
  return jsonb_build_object('id', v_id);
end $$;

-- Dispatch: approve, reject or suspend.
create or replace function public.admin_set_driver_approval(p_driver uuid, p_status public.approval_status, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := app.staff_operator(); d public.drivers;
begin
  update public.drivers
     set approval_status = p_status, reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(p_note), ''),
         -- Dispatch checked who this is, so the WhatsApp number counts as theirs.
         whatsapp_verified_at = case when p_status = 'approved' then coalesce(whatsapp_verified_at, now()) else whatsapp_verified_at end,
         on_shift = case when p_status = 'approved' then on_shift else false end,
         updated_at = now()
   where id = p_driver and operator_id = v_op returning * into d;
  if d.id is null then perform app.fail('driver_not_found', 404); end if;
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (v_op, auth.uid(), 'user', 'driver.review', 'driver', d.id, jsonb_build_object('status', p_status, 'note', p_note));
  return jsonb_build_object('id', d.id, 'status', d.approval_status, 'name', d.full_name, 'whatsapp', d.whatsapp_e164);
end $$;

-- Dispatch: a new one-time invitation (7 days). Returns the token once; only its hash is kept.
create or replace function public.admin_driver_invite(p_driver uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_op uuid := app.staff_operator(); d public.drivers; v_token text;
begin
  select * into d from public.drivers where id = p_driver and operator_id = v_op;
  if d.id is null then perform app.fail('driver_not_found', 404); end if;
  if d.auth_user_id is not null then perform app.fail('driver_has_login', 409); end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  update app.driver_invites set expires_at = now() where driver_id = d.id and used_at is null and expires_at > now();
  insert into app.driver_invites (token_hash, driver_id, created_by, expires_at)
  values (encode(sha256(convert_to('driver-invite:' || v_token, 'UTF8')), 'hex'), d.id, auth.uid(), now() + interval '7 days');
  return jsonb_build_object('token', v_token, 'name', d.full_name, 'whatsapp', d.whatsapp_e164);
end $$;

-- Server (service role): who an invitation is for, if it's still good.
create or replace function public.driver_invite_peek(p_token_hash text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('driverId', d.id, 'name', d.full_name, 'whatsapp', d.whatsapp_e164, 'operatorId', d.operator_id)
    from app.driver_invites i join public.drivers d on d.id = i.driver_id
   where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now() and d.auth_user_id is null;
$$;

-- Server (service role): the driver set up their login from the invitation.
create or replace function public.driver_invite_claim(p_token_hash text, p_user uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare i app.driver_invites; d public.drivers;
begin
  update app.driver_invites set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now() returning * into i;
  if i.token_hash is null then perform app.fail('invalid_invite', 410); end if;
  update public.drivers
     set auth_user_id = p_user, email = lower(p_email),
         whatsapp_verified_at = coalesce(whatsapp_verified_at, now()), updated_at = now()
   where id = i.driver_id and auth_user_id is null returning * into d;
  if d.id is null then perform app.fail('invalid_invite', 410); end if;
  insert into public.memberships (operator_id, user_id, role) values (d.operator_id, p_user, 'driver')
  on conflict (operator_id, user_id, role) do update set active = true, updated_at = now();
  return jsonb_build_object('driverId', d.id, 'name', d.full_name);
end $$;

-- Server (service role): "Quiero ser chofer". Pending until dispatch approves.
create or replace function public.driver_signup(
  p_operator uuid, p_user uuid, p_email text, p_full_name text, p_whatsapp text,
  p_vehicle_class text, p_plate text, p_vehicle_desc text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_phone text := app.e164(p_whatsapp); v_id uuid;
begin
  if coalesce(length(btrim(p_full_name)), 0) < 3 then perform app.fail('invalid_name', 422); end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then perform app.fail('invalid_phone', 422); end if;
  if exists (select 1 from public.drivers where operator_id = p_operator and whatsapp_e164 = v_phone) then perform app.fail('phone_in_use', 409); end if;
  insert into public.drivers (operator_id, auth_user_id, full_name, whatsapp_e164, email, approval_status, active, source)
  values (p_operator, p_user, btrim(p_full_name), v_phone, lower(p_email), 'pending', true, 'signup') returning id into v_id;
  perform app.assign_vehicle(p_operator, v_id, p_vehicle_class, p_plate, p_vehicle_desc, null, null);
  insert into public.memberships (operator_id, user_id, role) values (p_operator, p_user, 'driver')
  on conflict (operator_id, user_id, role) do update set active = true, updated_at = now();
  insert into public.audit_log (operator_id, actor_id, actor_kind, action, entity, entity_id, detail)
  values (p_operator, p_user, 'driver', 'driver.signup', 'driver', v_id, jsonb_build_object('name', btrim(p_full_name), 'plate', p_plate));
  return jsonb_build_object('id', v_id);
end $$;

-- Signed-in user: their driver application (any status), for the "en revisión" screen.
create or replace function public.driver_application() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('status', d.approval_status, 'active', d.active, 'fullName', d.full_name, 'note', d.review_note)
    from public.drivers d where d.auth_user_id = auth.uid() limit 1;
$$;

-- Vehicle types for the forms (public: the booking page already shows them).
create or replace function public.vehicle_class_options(p_operator uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'nameEs', c.label_es, 'nameEn', c.label_en,
                                              'maxPassengers', c.max_passengers, 'maxLargeBags', c.max_large_bags) order by c.sort_order, c.code), '[]'::jsonb)
    from public.vehicle_classes c
   where c.active and c.operator_id = coalesce(p_operator, (select id from public.operators order by created_at limit 1));
$$;

revoke all on function public.admin_drivers(), public.admin_save_driver(uuid, text, text, text, text, text, int, int, boolean),
  public.admin_set_driver_approval(uuid, public.approval_status, text), public.admin_driver_invite(uuid), public.driver_application()
  from public, anon;
grant execute on function public.admin_drivers(), public.admin_save_driver(uuid, text, text, text, text, text, int, int, boolean),
  public.admin_set_driver_approval(uuid, public.approval_status, text), public.admin_driver_invite(uuid), public.driver_application()
  to authenticated, service_role;
revoke all on function public.driver_invite_peek(text), public.driver_invite_claim(text, uuid, text),
  public.driver_signup(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.driver_invite_peek(text), public.driver_invite_claim(text, uuid, text),
  public.driver_signup(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.vehicle_class_options(uuid) to anon, authenticated, service_role;
revoke all on function app.assign_vehicle(uuid, uuid, text, text, text, int, int), app.staff_operator(public.member_role[]) from public, anon, authenticated;
