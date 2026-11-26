-- SoyTuTaxi airport transfers · Phase 1 foundation schema
-- Conventions:
--   * UUID primary keys, every business row scoped by operator_id.
--   * timestamptz (UTC instants) for moments; `date` for flight local arrival date.
--   * Money as bigint minor units + ISO-4217 currency char(3).
--   * Half-open tstzrange '[)' for occupied time.

-- Supabase keeps extensions in the `extensions` schema; GiST operator classes resolve by type.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role      as enum ('admin', 'dispatcher', 'finance', 'driver');
create type public.journey_direction as enum ('from_airport', 'to_airport');
create type public.booking_source   as enum ('web', 'whatsapp', 'staff', 'phone', 'voice');
create type public.booking_state    as enum ('requested', 'needs_driver', 'held', 'confirmed', 'closed', 'cancelled');
create type public.payment_mode     as enum ('prepaid', 'pay_on_pickup_cash', 'pay_on_pickup_card');
create type public.collection_state as enum ('not_applicable', 'awaiting_payment', 'pending_collection', 'collected', 'waived');
create type public.assignment_state as enum ('reserving', 'confirmed', 'released');
create type public.trip_stage       as enum ('scheduled', 'en_route', 'at_pickup', 'onboard', 'complete', 'no_show');
create type public.approval_status  as enum ('pending', 'approved', 'suspended', 'rejected');
create type public.availability_kind as enum ('recurring_shift', 'available', 'unavailable');
create type public.exception_severity as enum ('info', 'warning', 'critical');
create type public.exception_state  as enum ('open', 'acknowledged', 'resolved');
create type public.job_state        as enum ('pending', 'leased', 'done', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Operators and memberships
-- ---------------------------------------------------------------------------
create table public.operators (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text not null,
  timezone    text not null default 'America/Argentina/Buenos_Aires',
  demo_mode   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  user_id     uuid not null,                -- auth.users.id
  role        public.member_role not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (operator_id, user_id, role)
);
create index memberships_user_idx on public.memberships (user_id) where active;

-- ---------------------------------------------------------------------------
-- Vehicle classes, vehicles, drivers
-- ---------------------------------------------------------------------------
create table public.vehicle_classes (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id) on delete cascade,
  code            text not null check (code ~ '^[a-z_]{2,30}$'),
  label_es        text not null,
  label_en        text not null,
  max_passengers  int  not null check (max_passengers between 1 and 60),
  max_large_bags  int  not null check (max_large_bags between 0 and 60),
  max_carry_on    int  not null check (max_carry_on between 0 and 60),
  -- Optional joint rule: large bag = 2 units, carry-on = 1 unit. NULL = no joint rule.
  max_bag_units   int  check (max_bag_units is null or max_bag_units between 0 and 200),
  sort_order      int  not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (operator_id, code)
);

create table public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id) on delete cascade,
  vehicle_class   text not null,
  plate           text not null,
  description     text,
  -- Per-vehicle limits may be stricter than the class; NULL = class limit.
  max_passengers  int check (max_passengers is null or max_passengers between 1 and 60),
  max_large_bags  int check (max_large_bags is null or max_large_bags between 0 and 60),
  max_carry_on    int check (max_carry_on is null or max_carry_on between 0 and 60),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (operator_id, plate),
  foreign key (operator_id, vehicle_class) references public.vehicle_classes (operator_id, code)
);

create table public.drivers (
  id                    uuid primary key default gen_random_uuid(),
  operator_id           uuid not null references public.operators(id) on delete cascade,
  auth_user_id          uuid unique,                 -- auth.users.id once onboarded
  full_name             text not null,
  whatsapp_e164         text check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_verified_at  timestamptz,
  approval_status       public.approval_status not null default 'pending',
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (operator_id, whatsapp_e164)
);

create table public.driver_vehicle_allocations (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  period      tstzrange not null check (not isempty(period) and lower_inc(period) and not upper_inc(period)),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A vehicle is allocated to at most one driver at a time.
  constraint dva_vehicle_no_overlap exclude using gist (vehicle_id with =, period with &&) where (active)
);

-- Unavailability overrides always win over recurring shifts / available windows.
create table public.driver_availability (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid not null references public.operators(id) on delete cascade,
  driver_id     uuid not null references public.drivers(id) on delete cascade,
  kind          public.availability_kind not null,
  -- recurring_shift: weekday (0=Sunday) + local start/end time, interpreted in operator timezone
  weekday       smallint check (weekday between 0 and 6),
  start_local   time,
  end_local     time,
  -- available / unavailable: explicit instant interval
  during        tstzrange check (during is null or (lower_inc(during) and not upper_inc(during))),
  effective     daterange not null default daterange(current_date, null, '[)'),
  note          text,
  version       int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint availability_shape check (
    (kind = 'recurring_shift' and weekday is not null and start_local is not null and end_local is not null and during is null)
    or (kind in ('available', 'unavailable') and during is not null and weekday is null)
  )
);
create index driver_availability_driver_idx on public.driver_availability (driver_id);

-- ---------------------------------------------------------------------------
-- Geography, fares, policies
-- ---------------------------------------------------------------------------
create table public.airports (
  id                uuid primary key default gen_random_uuid(),
  operator_id       uuid not null references public.operators(id) on delete cascade,
  iata              char(3) not null check (iata ~ '^[A-Z]{3}$'),
  name              text not null,
  meeting_point_es  text not null,
  meeting_point_en  text not null,
  lat               double precision check (lat between -90 and 90),
  lng               double precision check (lng between -180 and 180),
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (operator_id, iata)
);

create table public.zones (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  code        text not null check (code ~ '^[a-z0-9_]{2,40}$'),
  name        text not null,
  -- GeoJSON Polygon coordinates: [[[lng,lat], ...]] (outer ring only in phase 1)
  polygon     jsonb not null check (jsonb_typeof(polygon) = 'array'),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (operator_id, code)
);

create table public.policies (
  id              uuid primary key default gen_random_uuid(),
  operator_id     uuid not null references public.operators(id) on delete cascade,
  version         int not null check (version > 0),
  label           text not null,
  is_demo         boolean not null default true,
  config          jsonb not null,
  effective_from  timestamptz not null default now(),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (operator_id, version),
  constraint policy_config_keys check (
    config ?& array[
      'quote_expiry_minutes', 'lead_time_minutes', 'max_advance_days', 'hold_minutes',
      'offer_expiry_minutes', 'auto_offer_group_size', 'turnaround_minutes',
      'arrival_buffer_minutes', 'allowed_payment_modes', 'waiting', 'cancellation',
      'flight_monitoring', 'escalation'
    ]
  )
);

create table public.fare_rules (
  id                uuid primary key default gen_random_uuid(),
  operator_id       uuid not null references public.operators(id) on delete cascade,
  direction         public.journey_direction not null,
  airport_id        uuid not null references public.airports(id),
  zone_id           uuid references public.zones(id),          -- NULL = any served zone
  zone_key          uuid generated always as (coalesce(zone_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  vehicle_class     text not null,
  rank              int not null default 100,                  -- lower wins
  amount_minor      bigint not null check (amount_minor > 0),
  taxes_minor       bigint not null default 0 check (taxes_minor >= 0),
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  est_duration_min  int not null check (est_duration_min between 5 and 600),
  effective         daterange not null default daterange(current_date, null, '[)'),
  is_demo           boolean not null default true,
  active            boolean not null default true,
  version           int not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (operator_id, vehicle_class) references public.vehicle_classes (operator_id, code),
  -- "Reject ambiguous matching rules": two active rules with the same scope and rank
  -- may not have overlapping effective dates.
  constraint fare_rules_unambiguous exclude using gist (
    operator_id with =, direction with =, airport_id with =, zone_key with =,
    vehicle_class with =, rank with =, effective with &&
  ) where (active)
);
create index fare_rules_lookup_idx on public.fare_rules (operator_id, direction, airport_id, vehicle_class) where active;

-- ---------------------------------------------------------------------------
-- Passengers, conversations (phase 3 fills these), quotes, bookings
-- ---------------------------------------------------------------------------
create table public.passengers (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid not null references public.operators(id) on delete cascade,
  full_name     text not null check (length(full_name) between 1 and 120),
  phone_e164    text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email         text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  whatsapp_wa_id text,
  locale        text not null default 'es-AR' check (locale in ('es-AR', 'en')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint passenger_reachable check (phone_e164 is not null or email is not null or whatsapp_wa_id is not null)
);
create index passengers_phone_idx on public.passengers (operator_id, phone_e164);

create table public.quotes (
  id                  uuid primary key default gen_random_uuid(),
  operator_id         uuid not null references public.operators(id) on delete cascade,
  session_hash        text not null,               -- sha256 hex of guest session / actor binding
  source              public.booking_source not null,
  kind                text not null check (kind in ('priced', 'manual')),
  direction           public.journey_direction not null,
  airport_id          uuid not null references public.airports(id),
  zone_id             uuid references public.zones(id),
  vehicle_class       text,
  passengers          int not null check (passengers between 1 and 60),
  large_bags          int not null check (large_bags between 0 and 60),
  carry_on            int not null check (carry_on between 0 and 60),
  pickup_at           timestamptz not null,
  journey             jsonb not null,              -- full normalized snapshot incl. places + flight
  fare                jsonb,                       -- breakdown (null for manual)
  amount_minor        bigint check (amount_minor is null or amount_minor > 0),
  currency            char(3),
  display_currency    char(3),
  fx_rate             numeric(18,8),
  fx_source           text,
  fx_at               timestamptz,
  fare_rule_id        uuid references public.fare_rules(id),
  fare_rule_version   int,
  policy_id           uuid not null references public.policies(id),
  manual_reasons      text[] not null default '{}',
  expires_at          timestamptz not null,
  consumed_booking_id uuid,
  consumed_at         timestamptz,
  created_at          timestamptz not null default now(),
  constraint quote_priced_has_amount check (
    (kind = 'priced' and amount_minor is not null and currency is not null and fare_rule_id is not null and vehicle_class is not null)
    or kind = 'manual'
  )
);
create index quotes_expiry_idx on public.quotes (expires_at) where consumed_booking_id is null;

create table public.bookings (
  id                         uuid primary key default gen_random_uuid(),
  operator_id                uuid not null references public.operators(id) on delete cascade,
  reference                  text not null unique check (reference ~ '^STT-[A-Z0-9]{6}$'),
  source                     public.booking_source not null,
  quote_id                   uuid not null unique references public.quotes(id),
  passenger_id               uuid not null references public.passengers(id),
  direction                  public.journey_direction not null,
  airport_id                 uuid not null references public.airports(id),
  zone_id                    uuid references public.zones(id),
  pickup_place               jsonb not null,   -- {label, original_text, lat?, lng?, verified}
  dropoff_place              jsonb not null,
  passengers                 int not null check (passengers between 1 and 60),
  large_bags                 int not null check (large_bags between 0 and 60),
  carry_on                   int not null check (carry_on between 0 and 60),
  vehicle_class              text not null,
  flight_designator          text check (flight_designator is null or flight_designator ~ '^[A-Z0-9]{2}[A-Z]?[0-9]{1,4}[A-Z]?$'),
  flight_local_arrival_date  date,
  flight_scheduled_arrival_at timestamptz,
  flight_exception_reason    text,
  flight_exception_by        uuid,
  agreed_pickup_at           timestamptz not null,
  proposed_pickup_at         timestamptz,
  est_duration_min           int not null check (est_duration_min between 5 and 600),
  state                      public.booking_state not null default 'needs_driver',
  payment_mode               public.payment_mode not null,
  collection_state           public.collection_state not null,
  amount_minor               bigint check (amount_minor is null or amount_minor > 0),
  currency                   char(3),
  policy_id                  uuid not null references public.policies(id),
  locale                     text not null check (locale in ('es-AR', 'en')),
  notes                      text check (notes is null or length(notes) <= 1000),
  linked_booking_id          uuid references public.bookings(id),   -- round trip partner
  version                    int not null default 1,
  status_token_hash          text not null,
  status_token_expires_at    timestamptz not null,
  idempotency_key            text not null check (length(idempotency_key) between 8 and 200),
  request_hash               text not null,
  cancelled_reason           text,
  created_by                 uuid,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (operator_id, idempotency_key),
  constraint airport_pickup_needs_flight check (
    direction = 'to_airport'
    or (flight_designator is not null and flight_local_arrival_date is not null)
    or (flight_exception_reason is not null and flight_exception_by is not null)
  ),
  constraint cancelled_has_reason check (state <> 'cancelled' or cancelled_reason is not null)
);
alter table public.quotes add constraint quotes_consumed_booking_fk
  foreign key (consumed_booking_id) references public.bookings(id) deferrable initially deferred;

create index bookings_upcoming_idx on public.bookings (operator_id, agreed_pickup_at);
create index bookings_state_idx on public.bookings (operator_id, state, agreed_pickup_at);
create index bookings_flight_idx on public.bookings (operator_id, airport_id, flight_local_arrival_date, flight_designator)
  where flight_designator is not null;

-- ---------------------------------------------------------------------------
-- Assignments and trip events
-- ---------------------------------------------------------------------------
create table public.assignments (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null references public.operators(id) on delete cascade,
  booking_id       uuid not null references public.bookings(id) on delete cascade,
  driver_id        uuid not null references public.drivers(id),
  vehicle_id       uuid not null references public.vehicles(id),
  state            public.assignment_state not null default 'reserving',
  trip_stage       public.trip_stage not null default 'scheduled',
  hold_expires_at  timestamptz,
  occupied         tstzrange not null check (not isempty(occupied) and lower_inc(occupied) and not upper_inc(occupied)),
  earnings_minor   bigint check (earnings_minor is null or earnings_minor >= 0),
  earnings_currency char(3),
  version          int not null default 1,
  released_reason  text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint reserving_has_hold check (state <> 'reserving' or hold_expires_at is not null),
  constraint assignment_driver_no_overlap  exclude using gist (driver_id with =, occupied with &&)  where (state <> 'released'),
  constraint assignment_vehicle_no_overlap exclude using gist (vehicle_id with =, occupied with &&) where (state <> 'released')
);
-- At most one active assignment per booking.
create unique index assignments_one_active_per_booking on public.assignments (booking_id) where state <> 'released';
create index assignments_driver_idx on public.assignments (driver_id, lower(occupied)) where state <> 'released';

create table public.trip_events (
  id             uuid primary key default gen_random_uuid(),
  operator_id    uuid not null references public.operators(id) on delete cascade,
  booking_id     uuid not null references public.bookings(id) on delete cascade,
  assignment_id  uuid references public.assignments(id),
  kind           text not null,            -- booking.created, booking.state_changed, trip.stage_changed, ...
  from_value     text,
  to_value       text,
  source         public.booking_source,
  actor_id       uuid,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index trip_events_booking_idx on public.trip_events (booking_id, created_at);

-- ---------------------------------------------------------------------------
-- Operations plumbing: exceptions, audit, inbox, outbox
-- ---------------------------------------------------------------------------
create table public.exceptions (
  id           uuid primary key default gen_random_uuid(),
  operator_id  uuid not null references public.operators(id) on delete cascade,
  booking_id   uuid references public.bookings(id) on delete cascade,
  kind         text not null,
  severity     public.exception_severity not null default 'warning',
  state        public.exception_state not null default 'open',
  owner_id     uuid,
  summary      text not null,
  evidence     jsonb not null default '{}',   -- sanitized: no tokens, card data or raw contact details
  due_at       timestamptz,
  resolved_at  timestamptz,
  resolved_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index exceptions_open_idx on public.exceptions (operator_id, severity, created_at) where state <> 'resolved';

create table public.audit_log (
  id           bigint generated always as identity primary key,
  operator_id  uuid references public.operators(id) on delete cascade,
  actor_id     uuid,
  actor_kind   text not null check (actor_kind in ('user', 'driver', 'passenger', 'system', 'provider')),
  action       text not null,
  entity       text not null,
  entity_id    uuid,
  reason       text,
  detail       jsonb not null default '{}',
  request_id   text,
  created_at   timestamptz not null default now()
);
create index audit_log_entity_idx on public.audit_log (entity, entity_id, created_at);

create table public.inbox_events (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid references public.operators(id) on delete cascade,
  provider      text not null,
  event_key     text not null,
  payload_ref   text,                         -- pointer to raw payload storage (service role only)
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_key)
);

create table public.outbox_jobs (
  id               uuid primary key default gen_random_uuid(),
  operator_id      uuid not null references public.operators(id) on delete cascade,
  kind             text not null,
  dedupe_key       text not null,              -- stable key for one logical side effect
  payload          jsonb not null default '{}',
  state            public.job_state not null default 'pending',
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_until      timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (operator_id, dedupe_key)
);
create index outbox_jobs_queue_idx on public.outbox_jobs (next_attempt_at) where state in ('pending', 'leased');

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['operators','memberships','vehicle_classes','vehicles','drivers',
    'driver_vehicle_allocations','driver_availability','airports','zones','fare_rules',
    'passengers','bookings','assignments','exceptions','outbox_jobs']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()',
                   t || '_touch', t);
  end loop;
end $$;
