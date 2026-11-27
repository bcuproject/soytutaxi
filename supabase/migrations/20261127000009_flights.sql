-- SoyTuTaxi · Flight data cache for the driver app's Vuelos tab (airport boards and flight status).
-- One shared cache keeps provider usage (and cost) low: each airport board is fetched at most every few
-- minutes no matter how many drivers look at it. Service role only.
create table public.flight_cache (
  key         text primary key,          -- board:EZE:arr | flight:AR1303:2026-11-28
  payload     jsonb not null,
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table public.flight_cache enable row level security;
alter table public.flight_cache force row level security;
revoke all on public.flight_cache from anon, authenticated;
