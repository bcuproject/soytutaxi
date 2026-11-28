# SoyTuTaxi airport transfers: Phase 1 (Foundation)

This release is the dispatch backend and web front end for Buenos Aires transfers between city zones and Ezeiza (EZE) or Aeroparque (AEP), built from the *SoyTuTaxi airport transfer system* brief dated 26 Nov 2026. It covers **build-order step 1** from that brief: migrations, auth roles, fixture routes and vehicles, the fare engine, the booking form and the dispatch schedule.

> **DEMO MODE.** With no Supabase credentials set, the app runs entirely in the browser against an in-memory store. A striped banner marks demo mode. All fares and policies are labelled demo values. Nothing is charged and no messages are sent.

## What's in this release

| Area | Delivered |
|---|---|
| Database | Full foundation schema across 20 tables, with enums, FKs, range/amount checks and `btree_gist` exclusion constraints on driver and vehicle occupancy. Ranges are half-open. There is one active assignment per booking, and fare rules cannot be ambiguous. RLS is on and forced for every table. |
| Roles | `admin`, `dispatcher`, `finance` and `driver` via `memberships`. Staff read through RLS and only admins edit configuration. Drivers see only their own row and assignments. Passengers have no direct table access. |
| Fare engine | Server-side and pure (`computeQuote`). It validates the timeline in `America/Argentina/Buenos_Aires`, checks zones and optional coordinates, and checks seat, per-bag-type and joint baggage capacity. Fare rules are direction-specific and ranked, with a manual-quote fallback. |
| Booking command | The `create_booking_from_quote` PL/pgSQL function locks the quote, then checks the idempotency key (replay returns the same result; a changed payload returns 409). It also checks session binding, expiry (DB clock), payment mode, lead time, contact and the flight-or-staff-exception rule. It consumes the quote and inserts the booking, trip event, audit row and outbox jobs in **one transaction**. |
| Public API | One Edge Function (`api`): `GET /api/config`, `POST /api/quotes`, `POST /api/bookings`, `GET /api/bookings/:ref`. It returns consistent JSON errors with request IDs, uses the 400/401/403/404/409/422/429 codes and rate-limits by IP and session. |
| Passenger web | Spanish (es-AR) and English. Screens: transfer form → quote review (vehicle eligibility with reasons, price hold countdown) → contact & payment mode → "request received, not yet confirmed" → status page (opaque token, stored only as a hash). Mobile-first. |
| Dispatch | Spanish-first. Daily **Agenda** (timeline per driver plus an unassigned lane), **Reservas** grid, and filters by date, airport, state, driver, payment and free text. Also an alerts strip (unassigned near pickup, expiring holds, flight exceptions), a booking drawer with original address text, map links and event history, and a staff-entered booking form that allows a no-flight exception with a reason. |
| Seed | Generated from one TypeScript fixtures file (`scripts/gen-seed.ts`), so the demo backend and the DB seed cannot drift. Seed data: 3 vehicle classes (capacities from soytutaxi.com), EZE/AEP with meeting points, 6 zones, 55 demo fare rules, 6 vehicles, 7 drivers and 8 bookings relative to "today". |

## Phase 2 — driver operations, live map, walkie-talkie

- **Driver app** at `/chofer` (installable from the browser). Drivers can start and end a shift, share GPS every ~15 s while on shift (the screen is kept awake), and accept or decline offers with a countdown. Their jobs show the passenger and a navigation link, and they record trip progress (on the way → at pickup → passenger on board → done, or no-show). The app also shows earnings and cash still to hand in, and has the radio.
- **Dispatch** gets a **Mapa** tab: OpenStreetMap with live car positions coloured by status (free / heading to pickup / with passenger / no signal / off shift). Positions arrive over Supabase Realtime. Each booking now has assign / reassign, offer to the N closest drivers, release and cancel actions. These take the expected version and give actionable errors (stale data, schedule conflict, out of hours, vehicle too small).
- **Rules in the database** (`20261126000003_driver_operations.sql`): one transactional allocation path for both staff assignment and driver acceptance. It locks booking → driver → vehicle and rechecks eligibility (approval, allocated vehicle, capacity, working hours, unavailability). The overlap exclusion constraints decide races. Offers have generations and expire on the database clock (`pg_cron` every minute). Earnings are recorded once per completed trip and cash separately. Staff see a driver's location only while that driver is on shift.
- **Payments not live yet:** prepaid trips go straight to *confirmed* when a driver is assigned, with collection still *awaiting payment*. Setting `"payments_enabled": true` in a new policy version switches on the hold → pay → confirm flow (Phase 4).
- **Walkie-talkie:** the `radio` Edge Function issues LiveKit tokens for one shared channel (`soytutaxi-radio`) to dispatchers and on-shift drivers. Hold to talk. It needs the secrets `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (the existing BCU LiveKit; its agent only joins rooms it is dispatched to as `bcu-taxi`, so it won't enter the radio room).
- **Limits of a web app:** GPS and radio work while the app is open on screen. iOS stops both in the background or when locked. A native wrapper is the upgrade path if that isn't enough.
- **Onboarding:** create the user in Supabase Auth, then run `select app.grant_role_by_email('soytutaxi','email','dispatcher');` for staff or `select app.link_driver_by_email('<driver uuid>','email');` for drivers.

## Job board (advance airport jobs) + nearest-first for urgent jobs

- **Board:** a booking that needs a driver and is more than `max(board_min_lead_hours=6, board_escalate_hours_before=12)` hours away appears in the driver app's **Bolsa** tab. Each driver only sees jobs that fit their vehicle and hours and don't clash with their schedule, with no passenger contact or exact address. **Tomar** uses the same race-safe allocation (one winner). There is a cap of `board_max_claims_per_day=4` board jobs per driver per local day.
- **Giving a job back:** a driver may return a claimed job until `board_release_until_hours_before=24` hours before pickup. It goes back on the board and dispatch gets a warning. After that point only dispatch can reassign it.
- **Urgent and unclaimed jobs:** once inside the 12-hour window (or booked inside it), `app.escalate_board()` (pg_cron, every 2 min) offers the job to the nearest eligible drivers in rounds. Each round skips drivers who declined or let an offer expire. Dispatch is alerted when this starts, critically when no eligible driver is left, and again after `auto_dispatch_max_rounds=5`.
- **Dispatch control:** the booking drawer can **Retener** (keep off the board), **Publicar en la bolsa**, start or stop **Oferta automática**, offer manually or assign directly. The grid and drawer show the board status.
- All numbers are optional policy keys. If a key is absent, the default applies.

## WhatsApp booking chat (Phase 3)

- **Passengers** book in Spanish or English by free text ("Llego a Ezeiza mañana 10:30 en AR1303, voy a Palermo, somos 2"), buttons and lists, or a shared 📍 location. The bot asks only for missing details, then shows the fixed price for review. It books through the same `computeQuote` and `create_booking_from_quote` as the website, so the channel cannot price or book differently. AI extraction is optional: with `AI_API_KEY` set, the Lovable gateway reads long messages, but its output is re-validated before use. Without the key, the built-in parser and buttons are used.
- **Commands:** *mi reserva* / *my booking*, *staff*, *cancelar*, *EN* / *ES*. Unpriced routes and loads that need a larger vehicle are handed to staff.
- **Dispatch → WhatsApp tab:** every chat, with a *pide persona* badge, **Tomar conversación** (pauses the bot), staff replies (within Meta's 24 h window), and **Devolver al bot**.
- **Notifications:** pg_cron calls `/whatsapp/outbox` every minute (pg_net, shared key in `app.private_settings`). Passengers get *confirmed* and *cancelled* notices, and verified drivers get offers with **Aceptar/Rechazar** buttons. Outside 24 h, an approved template is used if one is configured, otherwise the job is closed with reason `no_template`.
- **Security:** the webhook checks `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET`. Each message is processed once (inbox de-duplication). Conversation state uses optimistic locking. All `wa_*` functions are callable by the service role only.
- **Setup:** see [docs/WHATSAPP_SETUP.md](docs/WHATSAPP_SETUP.md) (Meta test number, secrets, webhook URL).

## Central de reservas (booking desk) and WhatsApp calls

- **`/central`** is a separate screen for call and chat takers (new `agent` role; dispatchers and admins can use it too). It has four tabs: **Entrantes** (bookings waiting at the desk, plus everything received in the last 48 h from any channel), **WhatsApp** (the chat inbox), **Llamadas** (call log with missed calls) and **+ Nueva reserva** (the staff booking form).
- **Auto / Manual switch:** in Auto, new bookings go straight to dispatch. In Manual, they get `desk_hold`. They stay off the job board, out of automatic escalation and hidden in Despacho until an agent sends them as **Automático** (nearest-first offers now), **Bolsa** (job board) or **Manual** (dispatcher assigns). See `desk_release`.
- **WhatsApp voice calls** (Cloud API Calling) ring in the browser. Meta's WebRTC offer is stored on `wa_calls`. The agent's browser builds the answer, and `/whatsapp/call-action` claims the call atomically (one agent wins) and sends `pre_accept` + `accept` to Meta. Audio goes browser ↔ WhatsApp directly. During a call, **+ Reserva para este cliente** opens the booking form prefilled with the caller's name and number. The booking is recorded as channel `phone` and linked to the call.

## Voice bot (WhatsApp calls answered by "Sofía", Fish Audio)

- The **Central → Llamadas** switch sets who answers: **👤 Central** (rings the browser) or **🤖 Bot**. In bot mode the webhook hands Meta's offer to LiveKit's WhatsApp connector (`AcceptWhatsAppCall`, agent `bcu-taxi`, attribute `bcu_assistant=soytutaxi`). The BCU server's worker then runs `voice-agent/soytutaxi_voice_agent.py`: Silero VAD, OpenAI transcription (es/en auto-detected), OpenAI LLM and Fish Audio TTS. If LiveKit fails, the call rings the Central.
- **The bot has no database access.** Its tools (`quote`, `book`, `bookings`, `note`) post to `/whatsapp/voice-tool` with an HMAC token bound to that one call. The server prices with `computeQuote`, books with `create_booking_from_quote` (channel `voice`) and takes the phone number from the call record, never from the AI. It also sends the reference and status link to the caller on WhatsApp. Retries with the same quote don't create a second booking.
- Notes and callback requests from the bot appear under **Para devolver la llamada**.
- Server install: see `voice-agent/README.md` and step 7 of `docs/WHATSAPP_SETUP.md`.

## Airport timetable (Vuelos)

- **Driver app → Vuelos** has three views. **Mis vuelos** shows the live status of the driver's own airport pickups in the next 30 h: scheduled vs estimated or actual landing and the shift in minutes, terminal, baggage belt, and the agreed pickup time. **Llegadas** and **Salidas** are boards for EZE and AEP covering the next 8 h, with search. The same boards are in **Despacho → Vuelos**.
- Data: AeroDataBox (`supabase/functions/_shared/flights/aerodatabox.ts`; swap this one file to change provider), through the `flights` Edge Function (drivers and staff only). A shared cache (`flight_cache`) means each board is fetched at most every 5 min, and each flight every 3 min near landing (30 min otherwise), however many drivers are looking. If the provider is down, the last copy is shown and marked as not updated.
- Secrets: `FLIGHTS_API_KEY` and `FLIGHTS_PROVIDER` (`apimarket`, the default, or `rapidapi`). Without a key, the tab explains that the provider isn't connected.

## Flight-based pickup changes and Mercado Pago (Phase 4)

- **Flight tracking.** Every 5 min, pg_cron calls `/flights/track`. Arrivals inside the monitoring window (24 h) are checked once per flight per policy interval.
  - **New pickup time:** estimated gate time (or runway time plus the taxi allowance, labelled as an estimate) plus the airport buffer gives a **suggested pickup**. Small changes under the threshold are ignored. `agreed_pickup_at` doesn't change until dispatch presses **Aprobar y avisar**. That moves the driver's slot too, or reports a clash and offers to release the driver. It supersedes open offers and notifies the passenger and the driver once.
  - **Review cases:** a cancelled flight, a diversion, a different arrival airport or an ambiguous flight raises a critical "revisar vuelo" alert and never moves the pickup.
  - **Provider failure:** the agreed time is kept, and "verificado hh:mm" shows how old the data is.
- **Payments.** When a driver reserves a prepaid trip (held), the passenger gets a WhatsApp message and a **Pagar con Mercado Pago** button on their status page. Checkout Pro is created server-side for the locked amount, converted to pesos with **Despacho → Cobros**, and expires with the hold.
  - **Confirmation:** only a notification whose `x-signature` checks out, followed by fetching the payment from Mercado Pago (reference, amount, currency and merchant checked), can confirm the trip. The return page just waits.
  - **Reconciliation:** duplicates are ignored, and "approved" never goes back to "pending". Late payments (hold expired), payments on cancelled bookings, extra payments and mismatched amounts are kept and go to reconciliation alerts.
  - **Refunds:** stored first, then sent once with an idempotency key and confirmed with Mercado Pago. The passenger is notified.
- Secrets (`payments` function): `MP_ACCESS_TOKEN` (`TEST-…` for sandbox), `MP_WEBHOOK_SECRET`, optional `MP_COLLECTOR_ID`. Set the policy's `payments_enabled` to true when going live.

## Passenger self-service, ratings and reminders
- Passengers cancel from the status page, WhatsApp ("Mi reserva" → ❌ Cancelar) or by phone (Sofía). The refund follows the booking's policy
  (`cancellation.free_until_hours_before` / `refund_percent_after`) and is sent to Mercado Pago automatically. Once the driver is on the way, only staff can cancel.
- 20 minutes after a completed trip the passenger is asked for a 1–5 rating (WhatsApp list or status page); 1–2 raises an alert and asks for a comment.
- Confirmed trips get a WhatsApp reminder the day before (08:00–22:00 Buenos Aires; early trips the evening before).

## Drivers: documents, pay statements; reports
- Despacho → Choferes → Documentación: licence, professional licence, insurance, VTV and remis permit per driver/vehicle. Daily alerts 30 days ahead and when expired.
  With **Activar bloqueo** on, a driver whose papers are invalid on the trip date can't be assigned, take offers or claim from the board.
- Despacho → Choferes → Pagos: per-driver balance (earnings − cash collected), adjustments, CSV, "Cerrar liquidación". Drivers see it in Ganancias.
- Despacho → Informes: bookings, revenue, driver pay, cancellations/refunds, ratings, per-day chart, channels, airports, zones, drivers; CSV.

## Hotel/agency accounts; transfer from Sofía to a person
- Despacho → Cuentas: accounts with discount and payment terms. In a booking, "Facturar a cuenta" bills the trip to the account (payment mode `account`).
  Drafts for last month are generated on the 1st; issue → mark paid (or void, which frees the trips). "Ver / imprimir" opens a printable statement.
- Sofía can put a caller through live: the Central shows "Sofía te pasa una llamada"; **Atender** joins the call's LiveKit room from the browser and Sofía steps out.
  If nobody answers within 45 s she takes the call back and leaves a callback request.

## WhatsApp assistant and customer memory
- With `AI_API_KEY` set, free questions on WhatsApp ("¿dónde me espera el chofer?", "do you have child seats?", "who is my driver?")
  are answered from the operator's facts and the customer's own memory. The AI only chooses an action; booking, cancelling and
  hand-off to a person run through the same validated flows as the buttons. Without the key, the bot works as before.
- Memory (`wa_customer_context`, per phone number): the last 8 bookings with live ride details (driver first name, car, plate, on the way —
  only after a driver accepted), the last 24 WhatsApp messages (30 days) and the last 5 calls (60 days) with Sofía's note and transcript.
  Sofía reads the same memory at the start of each call and saves her transcript when it ends; the Central shows it under 📋 Historial.

Before taking real bookings, work through `docs/GO_LIVE.md`.

## Live staging (26 Nov 2026)

- Supabase project `soytutaxi` (ref `sxjhtsyguacfyixaeydz`, São Paulo). Migrations and demo data applied, `api` Edge Function deployed (`verify_jwt = false`).
- API base: `https://sxjhtsyguacfyixaeydz.supabase.co/functions/v1/api/api/…` (e.g. `/config`).
- Front end for GitHub Pages: `VITE_BASE=/soytutaxi/ npm run build` (reads `.env.production.local`), then publish `dist/`. `public/404.html` handles deep links.
- `STATUS_TOKEN_SECRET` is not set yet, so the function falls back to a value derived from the project's server-only key. Set a dedicated secret before go-live. That invalidates earlier status links.
- `PUBLIC_APP_URL` is not set, so status links in API responses use the caller's origin. Set it to the full site URL (including `/soytutaxi`) before Phase 3 sends links by WhatsApp or email.

## Quick start

```bash
npm install
npm run dev            # demo mode on http://localhost:5173
#   /             passenger booking
#   /despacho     dispatch (click "Entrar como despacho (demo)")
```

## Tests

```bash
npm test               # 42 unit tests: domain, API handler (MemoryStore), LiveKit tokens
npm run test:db        # 42 integration tests on real PostgreSQL (Phase 1, Phase 2, job board)
npm run build && npx vite preview --port 4173 & npm run test:e2e   # browser smoke test (needs Chrome)
deno check supabase/functions/api/index.ts
```

`test:db` recreates a database `soytutaxi_test` via `scripts/db-reset.sh`. That script applies a small Supabase shim (`tests/db/supabase_shim.sql`), then all migrations, then the seed. Set `PGHOST/PGPORT/PGUSER` or `TEST_DATABASE_URL` to point at your server. The integration tests run the **same HTTP handler** as the Edge Function, against the real SQL functions, and cover:

- 10 concurrent identical requests → 1 booking, 9 idempotent replays
- 10 concurrent requests for one quote with different keys → 1 booking, 9 × `409 quote_already_used`
- overlap rejection for the same driver and for the same vehicle; back-to-back jobs allowed; released assignments don't block
- one active assignment per booking; ambiguous fare rules rejected at write time
- RLS: dispatcher vs non-member vs driver vs finance vs admin; anon can't execute commands

## Deploy to Supabase (staging first)

1. Create a Supabase project, then `supabase link --project-ref <ref>`.
2. `supabase db push` applies `supabase/migrations/*`. For staging only, run `supabase/seed.sql` (demo data) or leave the tables empty and enter live data through admin.
3. Set function secrets:
   ```bash
   supabase secrets set STATUS_TOKEN_SECRET=$(openssl rand -base64 48) \
     PUBLIC_APP_URL=https://<your-front-end> OPERATOR_SLUG=soytutaxi \
     ALLOWED_ORIGINS=https://<your-front-end> RATE_LIMIT_PER_MINUTE=60
   supabase functions deploy api --no-verify-jwt
   ```
4. Front end: set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then `npm run build` and host `dist/` with SPA fallback to `index.html`. With those vars set, demo mode turns off automatically.
5. Staff accounts: create the user in Supabase Auth, then in the SQL editor run
   `select app.grant_role_by_email('soytutaxi', 'person@soytutaxi.com', 'dispatcher');`
6. Before production, set `operators.demo_mode = false`. Then insert a **new** `policies` version and real `fare_rules` (`is_demo = false`). Policies are append-only, and each booking records the `policy_id` that governed it.

**Secret rotation:** changing `STATUS_TOKEN_SECRET` invalidates existing passenger status links. That is safe, but tell staff, since passengers will need a new link. **Backups:** use Supabase PITR on production. Restore drills belong in the go-live checklist.

## Layout

```
supabase/
  migrations/                 schema, RLS, commands (authoritative business transactions)
  seed.sql                    GENERATED from fixtures.ts
  functions/api/index.ts      Edge Function entry (Deno)
  functions/_shared/domain/   pure TS: types, time, geo, capacity, fare, quote, crypto, fixtures
  functions/_shared/api/      HTTP handler, Store port, SupabaseStore (Deno), MemoryStore (demo/tests)
src/                          React + TypeScript + Tailwind front end
tests/unit | tests/db | tests/e2e
scripts/gen-seed.ts, scripts/db-reset.sh
```

The domain code is shared verbatim by Deno, the browser and Node, so there is exactly one fare engine.

## Decisions worth knowing

- **Quote binding.** The browser holds a random guest session ID (`X-Session-Id`), and quotes store only its SHA-256. Staff quotes are bound to `user + session`.
- **Status links.** The token is `HMAC(secret, operator:idempotencyKey)` and only its hash is stored. That lets an idempotent replay return the *same* status URL without keeping the token in plain text.
- **Airport pickup time.** Agreed pickup = scheduled arrival + per-airport buffer (demo: EZE 60 min, AEP 30 min). The flight's *local arrival date* is stored separately from the pickup instant, so after-midnight arrivals keep the right flight date.
- **Manual quotes** are stored, can't be booked through the public API and show a WhatsApp handoff. Demo examples: Tigre (served zone, no rules) and TaxiBus city→EZE (unpriced reverse direction).
- **Prepaid** bookings start with `collection_state = awaiting_payment`. The payment link comes in Phase 4, once a driver has accepted.

## Known limitations of Phase 1

- **Not built yet:** offers, assignment, reassignment, cancellation and refund commands (Phase 2/4), WhatsApp (Phase 3), payments and flight tracking (Phase 4), voice (optional). The tables and constraints they need already exist, and dispatch shows a note where the actions will go.
- **Zones** are rough demo rectangles. Replace them with real neighbourhood polygons. Address geocoding is not wired, so coordinates are optional and are only checked against the chosen zone.
- **Rate limiting** in the function is per isolate. Add a gateway or WAF limit in production.
- **Demo mode** keeps bookings in memory: a page reload clears passenger bookings created in the demo. The seeded examples come back.
- **Dispatch auto-refresh** polls every 60 s. Supabase Realtime can replace that in Phase 2.
- **Live mode** was tested by typechecking under Deno plus integration tests of the same SQL. The thin `SupabaseStore` adapter needs a staging run against a real Supabase project.

## Confirm with SoyTuTaxi before production

Approved tariffs for each direction and vehicle, including reverse and larger-vehicle rates. Combined baggage rules for each class (carry-on limits for Minivan/TaxiBus are assumptions). Lead time, arrival buffers and cancellation policy. Which pay-on-pickup methods are allowed. Charge currency (ARS via Mercado Pago, with USD gated). Real service-zone boundaries. Meeting-point wording at EZE/AEP.
