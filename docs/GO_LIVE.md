# SoyTuTaxi — go-live checklist

Status checked against the live Supabase project (`sxjhtsyguacfyixaeydz`) on 27 Nov 2026.
✅ = done and verified · ⬜ = needs you (secrets, real data or a business decision).

## 1. Already in place
- ✅ Database: 15 migrations applied; live functions match the tested code exactly (fingerprint check, 126 functions + dispatch view).
- ✅ Row-level security on every table. Staff/driver commands check the caller's role inside the database (tests cover "forbidden").
  Supabase advisor: no anonymous access to any privileged function; the 3 tables without policies (`outbox_jobs`, `inbox_events`, `flight_cache`) are server-only by design.
- ✅ Background jobs running: WhatsApp outbox, payments, flight tracking, hold/offer expiry, job-board escalation, call expiry,
  day-before reminders, document alerts (08:07 daily), monthly account invoices (1st of the month, 06:17).
- ✅ Webhooks reject unsigned requests (WhatsApp: Meta signature; Mercado Pago: `x-signature`); worker endpoints need the outbox key.
- ✅ Website live at https://bcuproject.github.io/soytutaxi/ · source on GitHub `bcuproject/soytutaxi` (main).
- ✅ Tests: 170 automated (database + API + WhatsApp + payments + flights), 8 voice-agent tests, full browser smoke test.

## 2. Accounts and people  ⬜
- ⬜ **Staff logins — none exist yet.** Create each user in Supabase → Authentication → Users, then in the SQL editor:
  `select app.grant_role_by_email('soytutaxi', 'name@example.com', 'admin');` (roles: `admin`, `dispatcher`, `finance`, `agent`).
- ⬜ **Drivers — 7 in the database, none linked to a login.** Replace the demo drivers with real ones, create their logins, then
  `select app.link_driver_by_email('<driver id>', 'driver@example.com');`
- ⬜ Enter each driver's documents (Despacho → Choferes → Documentación), then press **Activar bloqueo**.
- ⬜ Create hotel/agency accounts (Despacho → Cuentas).

## 3. Leave demo mode  ⬜ (decision: real fares and policy)
- ⬜ Real fares: 55 demo fare rules are loaded. Replace with your price list.
- ⬜ Policy: the active policy is marked **DEMO** (`policies.is_demo = true`), and the operator is in demo mode (`operators.demo_mode = true`, shows the banner).
  Publish a new policy version with real lead time, cancellation (`free_until_hours_before`, `refund_percent_after`), driver share, waiting times.
- ⬜ Remove the 8 `STT-DEM…` demo bookings once you no longer need them for training (staff cancel them; they are not deleted).

## 4. Secrets (Supabase → Edge Functions → Secrets)  ⬜
| Feature | Secrets |
|---|---|
| WhatsApp chat + calls | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, optional `WHATSAPP_TEMPLATES`, `AI_API_KEY` |
| Sofía + call transfer + radio | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; Fish voice ID in Central → Llamadas |
| Flight times | `FLIGHTS_API_KEY` (+ `FLIGHTS_PROVIDER` = `apimarket` or `rapidapi`) |
| Mercado Pago | `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, optional `MP_COLLECTOR_ID`; then Despacho → Cobros (pesos per USD) and set `payments_enabled: true` in the policy |

Start with **test** credentials (Mercado Pago `TEST-…` token, a WhatsApp test number) and switch to live ones after a full test trip.

## 5. WhatsApp templates (needed for messages outside the 24 h window)  ⬜
Get these approved in Meta Business Manager and list them in `WHATSAPP_TEMPLATES`:
`notify.passenger.confirmed`, `notify.passenger.reminder`, `notify.passenger.cancelled`, `notify.passenger.payment_due`,
`notify.passenger.pickup_changed`, `notify.passenger.rating`, `notify.driver.offer`, `notify.driver.assigned`.
Without a template, a message to someone who hasn't written in the last 24 h is skipped (it never fails silently: the outbox records why).

## 6. Backups and recovery  ⬜
- ⬜ Check the Supabase plan: daily backups are included on Pro; Point-in-Time Recovery is an add-on. On the free plan there are **no** downloadable backups —
  upgrade before taking real bookings.
- ⬜ Keep a copy of the source (GitHub `main`) — every migration is in `supabase/migrations/`, so the schema can be rebuilt from scratch.
- Nothing is hard-deleted by the app: cancellations, refunds, voided invoices and settlements are all kept, with an `audit_log` entry.

## 7. Legal / money  ⬜
- ⬜ Account statements ("CTA-…") are internal summaries; issue the legal electronic invoice (AFIP/ARCA) separately.
- ⬜ Cancellation and refund rules shown to passengers come from the policy — confirm they match your published terms.
- ⬜ Privacy notice on the website (phone numbers, location of drivers, call notes).

## 8. Final dress rehearsal (with test credentials)  ⬜
1. Book on the website → appears in Central → send to dispatch.
2. Driver accepts in the app → passenger gets the WhatsApp confirmation → (prepaid) pays with Mercado Pago test card → confirmed.
3. Driver completes the trip → passenger gets the rating request 20 minutes later.
4. WhatsApp: book by chat, check "Mi reserva", cancel from the chat.
5. Call the WhatsApp number in Bot mode → Sofía answers → ask for a person → answer from the Central.
6. Close the driver's statement; generate and issue an account invoice.
