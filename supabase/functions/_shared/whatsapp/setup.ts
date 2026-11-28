// WhatsApp connection setup through the Graph API, run on the server with the WHATSAPP_ACCESS_TOKEN secret
// (a System User token). Nobody — staff or AI — ever sees the token: the Central's "Conexión WhatsApp" screen
// sends actions here and gets back only Meta's non-secret answers.
//
// Steps: status → add number → request code → verify code (typed by the admin) → register (PIN typed by the
// admin) → send THIS number's webhooks to SoyTuTaxi (per-number override; other lines untouched) → enable
// calling → create message templates.
import { GRAPH_VERSION } from "./meta.ts";

export type SetupAction = "status" | "add_number" | "request_code" | "verify_code" | "register" | "use_number"
  | "webhook" | "calling" | "templates" | "test_send" | "flows";

export interface SetupEnv {
  token: string;
  callbackUrl: string;      // https://<project>.supabase.co/functions/v1/whatsapp
  verifyToken: string;      // WHATSAPP_VERIFY_TOKEN
  wabaId?: string | null;
  phoneNumberId?: string | null;
  /** Only used to READ the app's webhook subscriptions (app access token = app id | app secret). */
  appSecret?: string | null;
  fetchImpl?: typeof fetch;
}

type Graph = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: any }>;

export function graph(token: string, fetchImpl: typeof fetch = fetch): Graph {
  return async (method, path, body) => {
    const r = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok && !data?.error, status: r.status, data };
  };
}

/** Meta's error, without anything secret (Graph errors never echo the token). */
const metaError = (d: any) => ({ code: d?.error?.code ?? null, subcode: d?.error?.error_subcode ?? null,
  message: String(d?.error?.error_user_msg || d?.error?.message || "Meta error").slice(0, 400) });

const PHONE_FIELDS = "id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type,messaging_limit_tier,webhook_configuration";

/** Message templates SoyTuTaxi uses outside WhatsApp's 24-hour window (variables in the order notify.ts sends them). */
export const TEMPLATES: { kind: string; name: string; category: "UTILITY"; body: string; example: string[]; buttons?: string[] }[] = [
  { kind: "notify.passenger.confirmed", name: "stt_trip_confirmed", category: "UTILITY",
    body: "✅ Tu viaje {{1}} del {{2}} está confirmado. Tu chofer es {{3}} ({{4}}). Detalles y estado: {{5}} ¡Buen viaje!",
    example: ["STT-AB12CD", "sábado 28/11, 10:30", "Carlos", "Toyota Corolla AB123CD", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"] },
  { kind: "notify.passenger.cancelled", name: "stt_trip_cancelled", category: "UTILITY",
    body: "Tu reserva {{1}} fue cancelada. Si es un error o necesitás ayuda, respondé a este mensaje.", example: ["STT-AB12CD"] },
  { kind: "notify.passenger.payment_due", name: "stt_payment_due", category: "UTILITY",
    body: "Reservamos un chofer para tu viaje {{1}} del {{2}}. Para confirmarlo, pagá {{3}} acá: {{4}} ¡Gracias!",
    example: ["STT-AB12CD", "sábado 28/11, 10:30", "$ 50.000", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"] },
  { kind: "notify.passenger.pickup_changed", name: "stt_pickup_changed", category: "UTILITY",
    body: "Tu vuelo cambió de horario: actualizamos la búsqueda de tu viaje {{1}} a las {{2}}. Detalles: {{3}} ¡Gracias!",
    example: ["STT-AB12CD", "sábado 28/11, 11:15", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"] },
  { kind: "notify.passenger.reminder", name: "stt_trip_reminder", category: "UTILITY",
    body: "⏰ Recordatorio: tu viaje {{1}} es el {{2}}. Si necesitás cambiar o cancelar, respondé acá o entrá a {{3}} ¡Te esperamos!",
    example: ["STT-AB12CD", "sábado 28/11, 10:30", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"] },
  { kind: "notify.passenger.rating", name: "stt_trip_rating", category: "UTILITY",
    body: "¡Gracias por viajar con SoyTuTaxi! ¿Cómo estuvo tu viaje {{1}}? Podés calificarlo desde el link de tu reserva.", example: ["STT-AB12CD"] },
  { kind: "notify.passenger.refund", name: "stt_refund", category: "UTILITY",
    body: "Procesamos el reembolso de tu reserva {{1}}. Puede tardar unos días hábiles en verse en tu medio de pago.", example: ["STT-AB12CD"] },
  { kind: "notify.driver.offer", name: "stt_driver_offer_v2", category: "UTILITY",
    body: "🚕 Viaje disponible {{1}}: {{2}}. Ganancia {{3}}. Aceptalo con el botón o desde la app de choferes.",
    example: ["STT-AB12CD", "sábado 28/11, 10:30", "$ 35.000"] , buttons: ["Aceptar", "Rechazar"] },
  { kind: "notify.driver.invite", name: "stt_driver_invite", category: "UTILITY",
    body: "Hola {{1}}, te sumamos como chofer de SoyTuTaxi. Creá tu acceso a la app de choferes acá: {{2}} El link vence en 7 días.",
    example: ["Pedro", "https://bcuproject.github.io/soytutaxi/chofer?invite=abc"] },
  { kind: "notify.driver.approved", name: "stt_driver_approved", category: "UTILITY",
    body: "¡Hola {{1}}! Tu solicitud para manejar con SoyTuTaxi fue aprobada. Entrá a la app de choferes: {{2}} y activá tu turno para recibir viajes.",
    example: ["Ana", "https://bcuproject.github.io/soytutaxi/chofer"] },
  { kind: "notify.staff.message", name: "stt_staff_message", category: "UTILITY",
    body: "Mensaje de SoyTuTaxi sobre tu reserva {{1}}: {{2}} Si necesitás algo, respondé a este mensaje.", example: ["STT-AB12CD", "Tu chofer llega en 10 minutos."] },
  { kind: "notify.driver.assigned", name: "stt_driver_assigned", category: "UTILITY",
    body: "Tenés asignado el viaje {{1}} del {{2}}. Los detalles están en la app de choferes.", example: ["STT-AB12CD", "sábado 28/11, 10:30"] },
  { kind: "notify.driver.pickup_changed", name: "stt_driver_pickup_changed", category: "UTILITY",
    body: "Cambió el horario del viaje {{1}}: nueva búsqueda {{2}}. Revisalo en la app de choferes.", example: ["STT-AB12CD", "sábado 28/11, 11:15"] },
  { kind: "notify.driver.released", name: "stt_driver_released", category: "UTILITY",
    body: "El viaje {{1}} del {{2}} ya no está asignado a vos. Gracias.", example: ["STT-AB12CD", "sábado 28/11, 10:30"] },
];

/** WhatsApp Flow: calendar + hour/minute dropdowns. No data endpoint: the bot passes the dates and labels when sending. */
export const DATETIME_FLOW_NAME = "stt_datetime_v2";
const two = (n: number) => String(n).padStart(2, "0");
export const DATETIME_FLOW_JSON = {
  version: "7.1",
  screens: [{
    id: "WHEN", title: "SoyTuTaxi", terminal: true, success: true,
    data: {
      intro: { type: "string", __example__: "Elegí el día y la hora programada de aterrizaje de tu vuelo." },
      min_date: { type: "string", __example__: "2026-11-28" },
      max_date: { type: "string", __example__: "2027-05-27" },
      date_label: { type: "string", __example__: "Fecha" },
      hour_label: { type: "string", __example__: "Hora de aterrizaje" },
      minute_label: { type: "string", __example__: "Minutos" },
    },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextBody", text: "${data.intro}" },
        { type: "CalendarPicker", name: "date", mode: "single", label: "${data.date_label}", "min-date": "${data.min_date}", "max-date": "${data.max_date}", required: true },
        { type: "Dropdown", name: "hour", label: "${data.hour_label}", required: true,
          "data-source": Array.from({ length: 24 }, (_, h) => ({ id: two(h), title: `${two(h)} h` })) },
        { type: "Dropdown", name: "minute", label: "${data.minute_label}", required: true,
          "data-source": Array.from({ length: 12 }, (_, i) => ({ id: two(i * 5), title: `:${two(i * 5)}` })) },
        { type: "Footer", label: "OK", "on-click-action": { name: "complete", payload: { date: "${form.date}", hour: "${form.hour}", minute: "${form.minute}" } } },
      ],
    },
  }],
};

export interface SetupResult { ok: boolean; status: number; body: Record<string, unknown>; save?: { phoneNumberId?: string; wabaId?: string; templates?: Record<string, { name: string; language: string }> } }

export async function runSetup(action: SetupAction, args: Record<string, unknown>, env: SetupEnv, g: Graph): Promise<SetupResult> {
  const fail = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ ok: false, status, body: { error: { code, ...extra } } });
  const str = (v: unknown, max = 100) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const phone = str(args.phoneNumberId, 30) || env.phoneNumberId || "";
  const waba = str(args.wabaId, 30) || env.wabaId || "";
  if (!env.token) return fail(503, "token_missing");

  switch (action) {
    case "status": {
      // Which WhatsApp Business Accounts this token can manage (from the token's own scopes).
      const dbg = await g("GET", `debug_token?input_token=${encodeURIComponent(env.token)}`);
      const scopes: { scope: string; target_ids?: string[] }[] = dbg.data?.data?.granular_scopes ?? [];
      const wabas = [...new Set(scopes.filter((s) => s.scope.startsWith("whatsapp_business")).flatMap((s) => s.target_ids ?? []))];
      const permissions = scopes.map((s) => s.scope);
      const accounts = [];
      for (const id of (waba ? [waba, ...wabas.filter((w) => w !== waba)] : wabas).slice(0, 5)) {
        const a = await g("GET", `${id}?fields=id,name,currency,timezone_id,account_review_status`);
        const p = await g("GET", `${id}/phone_numbers?fields=${PHONE_FIELDS}`);
        accounts.push({ ...(a.ok ? a.data : { id, error: metaError(a.data) }), phoneNumbers: p.ok ? p.data?.data ?? [] : [] });
      }
      let calling = null;
      if (phone) {
        const s = await g("GET", `${phone}/settings`);
        calling = s.ok ? s.data?.calling ?? null : metaError(s.data);
      }
      // Which webhook fields the Meta app is subscribed to (read-only). A per-number override only receives
      // the fields the app subscribes to, so "calls" must be there for WhatsApp calls to arrive.
      let appWebhook: { fields: string[]; defaultCallback: string | null } | null = null;
      const appId = dbg.data?.data?.app_id;
      if (appId && env.appSecret) {
        try {
          const r = await (env.fetchImpl ?? fetch)(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/subscriptions?access_token=${encodeURIComponent(`${appId}|${env.appSecret}`)}`);
          const j = await r.json().catch(() => ({}));
          const sub = (j?.data ?? []).find((x: any) => x.object === "whatsapp_business_account");
          appWebhook = { fields: (sub?.fields ?? []).map((f: any) => f.name ?? f), defaultCallback: sub?.callback_url ?? null };
        } catch { appWebhook = null; }
      }
      const me = await g("GET", "me?fields=id,name");
      // Discovery (read-only): which WhatsApp accounts this system user and its business can actually reach.
      const discovered: Record<string, unknown> = {};
      if (me.ok && me.data?.id) {
        const a = await g("GET", `${me.data.id}/assigned_whatsapp_business_accounts?fields=id,name`);
        discovered.assigned = a.ok ? a.data?.data ?? [] : metaError(a.data);
        const b = await g("GET", `${me.data.id}/businesses?fields=id,name`);
        const biz = b.ok ? (b.data?.data ?? []).slice(0, 3) : [];
        if (!b.ok) discovered.businessesError = metaError(b.data);
        discovered.businesses = [];
        for (const x of biz) {
          const o = await g("GET", `${x.id}/owned_whatsapp_business_accounts?fields=id,name`);
          const c = await g("GET", `${x.id}/client_whatsapp_business_accounts?fields=id,name`);
          (discovered.businesses as unknown[]).push({ id: x.id, name: x.name,
            owned: o.ok ? o.data?.data ?? [] : metaError(o.data), client: c.ok ? c.data?.data ?? [] : metaError(c.data) });
        }
      }
      return { ok: true, status: 200, body: {
        appWebhook,
        tokenOwner: me.ok ? me.data : metaError(me.data), discovered,
        tokenScopes: scopes.map((s) => ({ scope: s.scope, targets: s.target_ids ?? null })),
        tokenValid: !!dbg.data?.data?.is_valid, appId: dbg.data?.data?.app_id ?? null, expiresAt: dbg.data?.data?.expires_at ?? null,
        permissions, accounts, selected: { wabaId: waba || null, phoneNumberId: phone || null }, calling,
        callbackUrl: env.callbackUrl,
      } };
    }

    case "add_number": {
      const cc = str(args.countryCode, 4).replace(/\D/g, "");
      const number = str(args.phoneNumber, 20).replace(/\D/g, "");
      const name = str(args.displayName, 60);
      if (!waba) return fail(422, "waba_required");
      if (!cc || number.length < 6 || name.length < 3) return fail(422, "invalid_number");
      const r = await g("POST", `${waba}/phone_numbers`, { cc, phone_number: number, verified_name: name });
      return r.ok ? { ok: true, status: 200, body: { phoneNumberId: r.data.id }, save: { phoneNumberId: r.data.id, wabaId: waba } }
        : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "request_code": {
      if (!phone) return fail(422, "phone_required");
      const method = args.method === "VOICE" ? "VOICE" : "SMS";
      const r = await g("POST", `${phone}/request_code`, { code_method: method, language: str(args.language, 10) || "es" });
      return r.ok ? { ok: true, status: 200, body: { sent: true, method } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "verify_code": {
      const code = str(args.code, 10).replace(/\D/g, "");
      if (!phone || code.length !== 6) return fail(422, "invalid_code");
      const r = await g("POST", `${phone}/verify_code`, { code });
      return r.ok ? { ok: true, status: 200, body: { verified: true } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "register": {
      const pin = str(args.pin, 10).replace(/\D/g, "");
      if (!phone || pin.length !== 6) return fail(422, "invalid_pin");
      const r = await g("POST", `${phone}/register`, { messaging_product: "whatsapp", pin });
      return r.ok ? { ok: true, status: 200, body: { registered: true }, save: { phoneNumberId: phone, ...(waba ? { wabaId: waba } : {}) } }
        : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "use_number": {   // an already-registered number in the account
      if (!phone) return fail(422, "phone_required");
      const r = await g("GET", `${phone}?fields=${PHONE_FIELDS}`);
      return r.ok ? { ok: true, status: 200, body: { number: r.data }, save: { phoneNumberId: phone, ...(waba ? { wabaId: waba } : {}) } }
        : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "webhook": {
      if (!phone) return fail(422, "phone_required");
      if (!env.verifyToken) return fail(503, "verify_token_missing");
      // Make sure the token's app receives this account's webhooks, then send this number's to SoyTuTaxi only.
      if (waba) {
        const sub = await g("POST", `${waba}/subscribed_apps`);
        if (!sub.ok) return fail(400, "meta_error", { step: "subscribe_app", meta: metaError(sub.data) });
      }
      const r = await g("POST", phone, { webhook_configuration: { override_callback_uri: env.callbackUrl, verify_token: env.verifyToken } });
      if (!r.ok) return fail(400, "meta_error", { step: "override_callback", meta: metaError(r.data) });
      const check = await g("GET", `${phone}?fields=webhook_configuration`);
      return { ok: true, status: 200, body: { webhook: check.data?.webhook_configuration ?? null } };
    }

    case "calling": {
      if (!phone) return fail(422, "phone_required");
      const enable = args.enable !== false;
      const r = await g("POST", `${phone}/settings`, { calling: enable
        // Calls must arrive as webhooks (Central in the browser / Sofía on LiveKit), never forwarded over SIP.
        ? { status: "ENABLED", call_icon_visibility: "DEFAULT", sip: { status: "DISABLED" } }
        : { status: "DISABLED" } });
      if (!r.ok) return fail(400, "meta_error", { meta: metaError(r.data) });
      const s = await g("GET", `${phone}/settings`);
      return { ok: true, status: 200, body: { calling: s.data?.calling ?? null } };
    }

    case "test_send": {
      // Sends Meta's built-in "hello_world" template to one number, to test sending and delivery webhooks.
      if (!phone) return fail(422, "phone_required");
      const to = str(args.to, 20).replace(/\D/g, "");
      if (to.length < 8) return fail(422, "to_required");
      const r = await g("POST", `${phone}/messages`, { messaging_product: "whatsapp", to, type: "template",
        template: { name: "hello_world", language: { code: "en_US" } } });
      return r.ok ? { ok: true, status: 200, body: { sent: r.data } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }

    case "flows": {
      // Creates (or finds) and publishes the date & time form, then saves its id for the bot.
      if (!waba) return fail(422, "waba_required");
      const list = await g("GET", `${waba}/flows?fields=id,name,status&limit=100`);
      let flow = list.ok ? (list.data?.data ?? []).find((f: { name: string }) => f.name === DATETIME_FLOW_NAME) : null;
      if (!flow) {
        const c = await g("POST", `${waba}/flows`, { name: DATETIME_FLOW_NAME, categories: ["APPOINTMENT_BOOKING"], flow_json: JSON.stringify(DATETIME_FLOW_JSON), publish: true });
        if (!c.ok) return fail(400, "meta_error", { step: "create_flow", meta: metaError(c.data) });
        if (c.data?.validation_errors?.length) return fail(400, "flow_invalid", { id: c.data.id, errors: c.data.validation_errors });
        flow = { id: c.data.id, name: DATETIME_FLOW_NAME, status: "PUBLISHED" };
      } else if (flow.status === "DRAFT") {
        const pub = await g("POST", `${flow.id}/publish`);
        if (!pub.ok) return fail(400, "meta_error", { step: "publish_flow", id: flow.id, meta: metaError(pub.data) });
        flow.status = "PUBLISHED";
      }
      return { ok: true, status: 200, body: { flow }, save: { templates: { "flow.datetime": { name: String(flow.id), language: "flow" } } } };
    }

    case "templates": {
      if (!waba) return fail(422, "waba_required");
      const existing = await g("GET", `${waba}/message_templates?fields=name,status,language&limit=200`);
      const have = new Map<string, { status: string; language: string }>((existing.data?.data ?? []).map((t: any) => [t.name, t]));
      const results: { kind: string; name: string; status: string; error?: unknown }[] = [];
      const map: Record<string, { name: string; language: string }> = {};
      for (const t of TEMPLATES) {
        const ex = have.get(t.name);
        if (ex) { results.push({ kind: t.kind, name: t.name, status: ex.status }); map[t.kind] = { name: t.name, language: ex.language }; continue; }
        const r = await g("POST", `${waba}/message_templates`, {
          name: t.name, language: "es_AR", category: t.category,
          components: [{ type: "BODY", text: t.body, example: { body_text: [t.example] } },
            ...(t.buttons ? [{ type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })) }] : [])],
        });
        if (r.ok) { results.push({ kind: t.kind, name: t.name, status: r.data.status ?? "PENDING" }); map[t.kind] = { name: t.name, language: "es_AR" }; }
        else results.push({ kind: t.kind, name: t.name, status: "ERROR", error: metaError(r.data) });
      }
      return { ok: true, status: 200, body: { templates: results }, save: { templates: map } };
    }
  }
  return fail(400, "unknown_action");
}
