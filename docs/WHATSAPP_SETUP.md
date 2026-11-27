# Connecting the WhatsApp booking chat (Meta test number)

This guide uses a **Meta test number**, not the live SoyTuTaxi business number. It takes about 15 minutes.
Until the secrets below are set, the `whatsapp` function answers `whatsapp_not_configured` and nothing is sent.

## 1. Create the Meta app and test number

1. Go to <https://developers.facebook.com/apps> → **Create app** → use case **Other** → type **Business**.
2. In the app dashboard, add the **WhatsApp** product. Meta creates a **test phone number** for you.
3. Open **WhatsApp → API Setup**. Copy:
   - **Phone number ID** (the test number's ID, not the phone number itself)
   - **Temporary access token** (valid 24 h). For a token that doesn't expire, create a **System User** in
     Business Settings → System users, give it the app with `whatsapp_business_messaging` and
     `whatsapp_business_management`, and generate a token.
4. Under **To**, add up to **5 recipient numbers** (your own phone, a colleague, a driver). Each one gets a
   confirmation code by WhatsApp. The test number can only message these numbers.
5. Open **App settings → Basic** and copy the **App secret**.

## 2. Add the secrets in Supabase

Supabase dashboard → project **soytutaxi** → **Edge Functions → Secrets** → add:

| Secret | Value |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | the access token from step 1.3 |
| `WHATSAPP_PHONE_NUMBER_ID` | the phone number ID from step 1.3 |
| `WHATSAPP_APP_SECRET` | the app secret from step 1.5 (used to verify that webhooks really come from Meta) |
| `WHATSAPP_VERIFY_TOKEN` | any long random text you make up, e.g. `stt-` + 30 random characters |
| `AI_API_KEY` | *optional* — the Lovable AI gateway key (same one BlackCabUnite uses). Without it the bot still works with its built-in Spanish/English parser and buttons. |
| `AI_BASE_URL`, `AI_MODEL` | *optional* — only to use OpenAI/Gemini directly instead of the Lovable gateway |
| `WHATSAPP_TEMPLATES` | *optional* — see step 5 |

## 3. Point Meta's webhook at Supabase

WhatsApp → **Configuration** → Webhook → **Edit**:

- **Callback URL:** `https://sxjhtsyguacfyixaeydz.supabase.co/functions/v1/whatsapp`
- **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`

Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.

## 4. Try it

From one of the recipient phones, send the test number:

> Hola! Llego a Ezeiza mañana 10:30 en el AR1303, voy a Palermo, somos 2 con 2 valijas

The bot asks only for what's missing (here: the address), shows the fixed price with **Confirmar / Cambiar / Staff**
buttons, asks for the name and payment method, and replies with the booking reference and status link.
The booking appears in **Despacho** like any web booking (channel `whatsapp`), and the chat appears in the
**WhatsApp** tab, where a dispatcher can **Tomar conversación** (the bot pauses) and answer directly.

Other things to try: send **EN** to switch to English, **mi reserva** to list bookings, **staff** for a person,
or share a 📍 location instead of typing the address.

**Drivers:** a driver whose WhatsApp number is saved and verified in `drivers.whatsapp_e164` is recognised
automatically. Trip offers reach them with **Aceptar / Rechazar** buttons. For a test, add the driver's phone
as a recipient in step 1.4 and set their number on the driver record.

## 5. Messages outside the 24-hour window (optional)

WhatsApp only allows free-form messages within 24 h of the customer's last message. Confirmations and
driver offers sent later need a **pre-approved template**. Create templates in WhatsApp Manager, then set
`WHATSAPP_TEMPLATES`, for example:

```json
{
  "notify.passenger.confirmed": { "name": "trip_confirmed", "language": "es_AR" },
  "notify.passenger.cancelled": { "name": "trip_cancelled", "language": "es_AR" },
  "notify.driver.offer":        { "name": "driver_offer",   "language": "es_AR" }
}
```

Template body variables, in order:

- **confirmed:** reference, date and time, driver, vehicle and plate, status link
- **cancelled:** reference
- **driver offer:** reference, date and time, earnings (plus two quick-reply buttons: Accept, Decline)

Without a template, a notification that falls outside the window is skipped. The reason `no_template` is recorded in the outbox.

## 6. WhatsApp voice calls in the Central de reservas

Customers can tap the 📞 call button in the WhatsApp chat. The call rings on the **Central de reservas**
(`/central`), where an agent answers in the browser with a headset.

1. In WhatsApp → **Configuration → Webhook fields**, also subscribe to **calls**.
2. Turn calling on for the number. In Graph API Explorer (or curl), using the same access token:
   `POST https://graph.facebook.com/v22.0/<PHONE_NUMBER_ID>/settings` with body
   `{"calling": {"status": "ENABLED", "call_icon_visibility": "DEFAULT"}}`.
   Meta requires a messaging limit of 2,000 or more for real numbers. Test numbers are meant for trying calling out.
3. Open `/central` in Chrome or Edge on a computer with a headset, log in, and allow the microphone when asked.
   Keep the tab open: calls ring there with a sound and **Atender / Rechazar** buttons.
4. Calls must be answered within about 30–60 seconds, or WhatsApp shows the caller "Not answered" and the call
   appears as **Perdida** in the Llamadas tab.

**Who can use the Central:** create the person in Supabase Auth, then run
`select app.grant_role_by_email('soytutaxi', 'person@email', 'agent');`. Agents use the Central and the WhatsApp
inbox and can create bookings. They can't assign drivers or cancel in Despacho. Dispatchers and admins can use both screens.

**Auto / Manual (top right of the Central):**
- **Auto:** every new booking (web, WhatsApp bot, phone) goes straight to dispatch.
- **Manual:** new bookings wait under **Entrantes → Por enviar a despacho** until an agent sends them, choosing one of:
  - **⚡ Automático:** offered right away to the nearest free drivers.
  - **📋 Bolsa:** listed on the drivers' job board; urgent jobs are still offered automatically.
  - **👤 Manual:** stays in Despacho for a dispatcher to assign.

## Moving to the real number later

Register the live SoyTuTaxi number in the same Meta app, then replace `WHATSAPP_PHONE_NUMBER_ID` and
`WHATSAPP_ACCESS_TOKEN` (a System User token). Nothing else changes. Do this only once the test run is signed off.
