// Supabase Edge Function `whatsapp` (deploy with --no-verify-jwt; every route authenticates itself).
//   GET  /whatsapp              Meta webhook verification (hub.challenge, WHATSAPP_VERIFY_TOKEN)
//   POST /whatsapp              Meta webhook: X-Hub-Signature-256 checked with WHATSAPP_APP_SECRET
//   POST /whatsapp/outbox       notification worker, called every minute by pg_cron (x-outbox-key)
//   POST /whatsapp/staff-send   staff reply from the inbox (Supabase access token; admin, dispatcher or agent)
//   POST /whatsapp/call-action  answer (SDP), reject or hang up a WhatsApp voice call (same staff check)
//   POST /whatsapp/setup        WhatsApp connection setup (admin login; outbox key for no-code steps)
//   POST /whatsapp/call-join    take a call Sofía is transferring: LiveKit token for that call's room (staff)
//   POST /whatsapp/voice-tool   tools for the voice bot (LiveKit agent on the BCU server), per-call token
// Voice bot secrets: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (same LiveKit project as the agent),
//                    optional VOICE_TOKEN_SECRET.
// Secrets: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN,
//          optional AI_API_KEY (+ AI_BASE_URL, AI_MODEL), WHATSAPP_TEMPLATES (JSON), PUBLIC_APP_URL.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "../_shared/api/store.ts";
import { SupabaseStore } from "../_shared/api/supabaseStore.ts";
import { makeAssistant, makeExtractor } from "../_shared/whatsapp/ai.ts";
import { graphCalls, graphSender, parseWebhook, verifySignature } from "../_shared/whatsapp/meta.ts";
import type { NotificationContext, TemplateMap } from "../_shared/whatsapp/notify.ts";
import { liveKitVoiceBot, voiceTool, type VoiceCall } from "../_shared/whatsapp/voice.ts";
import { mintLiveKitToken } from "../_shared/domain/livekit.ts";
import { graph, runSetup, type SetupAction } from "../_shared/whatsapp/setup.ts";
import { callAction, processOutbox, processWebhook, sendAndRecord, type CallRow, type ConversationRow, type ServiceDeps, type WaDb } from "../_shared/whatsapp/service.ts";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const first = Object.values(JSON.parse(keys) as Record<string, string>)[0];
    if (first) return first;
  }
  throw new Error("missing service role / secret key");
}

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const KEY = serviceKey();
const db = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseStore(SUPABASE_URL, KEY);
const SLUG = env("OPERATOR_SLUG") || "soytutaxi";
const PUBLIC_APP_URL = env("PUBLIC_APP_URL") || "https://bcuproject.github.io/soytutaxi";
const STATUS_SECRET = env("STATUS_TOKEN_SECRET") || `status:${KEY}`;
const CORS = {
  "access-control-allow-origin": env("ALLOWED_ORIGINS") || "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "whatsapp", ...o }));

let envTemplates: TemplateMap = {};
try { envTemplates = JSON.parse(env("WHATSAPP_TEMPLATES") || "{}"); } catch { log({ level: "warn", msg: "WHATSAPP_TEMPLATES is not valid JSON" }); }
const TOKEN = env("WHATSAPP_ACCESS_TOKEN");

/** Number ID, account ID and template names: secrets win; otherwise what the setup screen saved (refreshed every 30 s). */
const RT: { phoneId: string; wabaId: string; templates: TemplateMap; at: number } = {
  phoneId: env("WHATSAPP_PHONE_NUMBER_ID"), wabaId: env("WHATSAPP_WABA_ID"), templates: envTemplates, at: 0,
};
async function refreshRuntime(force = false) {
  if (!force && Date.now() - RT.at < 30_000) return;
  RT.at = Date.now();
  try {
    const { data } = await db.rpc("wa_runtime_get");
    RT.phoneId = env("WHATSAPP_PHONE_NUMBER_ID") || data?.phoneNumberId || "";
    RT.wabaId = env("WHATSAPP_WABA_ID") || data?.wabaId || "";
    RT.templates = { ...(data?.templates ?? {}), ...envTemplates };
  } catch { /* keep the last known values */ }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.message && /^[a-z_]+$/.test(error.message)) throw new ApiError(Number(error.details) || 400, error.message, error.hint ?? error.message);
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as T;
}

const waDb: WaDb = {
  openConversation: (op, wa, name) => rpc<ConversationRow>("wa_open_conversation", { p_operator: op, p_wa_id: wa, p_profile_name: name }),
  saveConversation: (id, v, step, draft, locale, lastBooking, needsStaff) =>
    rpc<number | null>("wa_save_conversation", { p_id: id, p_expected_version: v, p_step: step, p_draft: draft, p_locale: locale, p_last_booking: lastBooking, p_needs_staff: needsStaff }),
  recordMessage: (c, dir, pid, kind, body, preview, status, sentBy = null) =>
    rpc<string | null>("wa_record_message", { p_conversation: c, p_direction: dir, p_provider_id: pid, p_kind: kind, p_body: body, p_preview: preview, p_status: status, p_sent_by: sentBy }),
  markSent: (id, pid, status, error = null) => rpc("wa_mark_sent", { p_message: id, p_provider_id: pid, p_status: status, p_error: error }),
  statusUpdate: (pid, status, error = null) => rpc("wa_status_update", { p_provider_id: pid, p_status: status, p_error: error }),
  inboxClaim: (op, key) => rpc<boolean>("wa_inbox_claim", { p_operator: op, p_event_key: key }),
  inboxDone: (key) => rpc("wa_inbox_done", { p_event_key: key }),
  bookingsForPhone: (op, phone) => rpc("wa_bookings_for_phone", { p_operator: op, p_phone: phone }),
  driverRespond: (d, o, a) => rpc("wa_driver_respond", { p_driver: d, p_offer: o, p_accept: a }),
  customerContext: (op, phone) => rpc("wa_customer_context", { p_operator: op, p_phone: phone }),
  callTranscript: (id, t) => rpc("wa_call_transcript", { p_call_id: id, p_transcript: t }),
  callTransferRequest: (id, reason) => rpc("wa_call_transfer_request", { p_call_id: id, p_reason: reason }),
  callTransferFailed: (id) => rpc("wa_call_transfer_failed", { p_call_id: id }),
  async callTransferClaim(id, user) {
    const r = await rpc<{ id: string | null; operator_id: string; bot_room: string | null; provider_call_id: string }>("wa_call_transfer_claim", { p_call: id, p_user: user });
    return r?.id ? r as { id: string; operator_id: string; bot_room: string | null; provider_call_id: string } : null;
  },
  passengerCancel: (op, phone, ref, ok, via) => rpc("wa_passenger_cancel", { p_operator: op, p_phone: phone, p_reference: ref, p_confirm: ok, p_via: via }),
  rate: (op, phone, id, n, c) => rpc("wa_rate", { p_operator: op, p_phone: phone, p_booking: id, p_score: n, p_comment: c }),
  outboxClaim: (limit) => rpc("wa_outbox_claim", { p_limit: limit }),
  outboxFinish: (job, ok, error, final) => rpc("wa_outbox_finish", { p_job: job, p_ok: ok, p_error: error, p_final: final }),
  notificationContext: (kind, payload) => rpc<NotificationContext | null>("wa_notification_context", { p_kind: kind, p_payload: payload }),
  openConversationForNotify: (op, wa) => rpc<string | null>("wa_open_conversation_for_notify", { p_operator: op, p_wa_id: wa }),
  callIncoming: (op, id, wa, name, sdp) => rpc<string | null>("wa_call_incoming", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_sdp: sdp }),
  callTerminated: (id, status, duration, error) => rpc("wa_call_terminated", { p_call_id: id, p_status: status, p_duration: duration, p_error: error }),
  async callGet(id) {
    const { data, error } = await db.from("wa_calls").select("id, operator_id, provider_call_id, status, answered_by").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as CallRow) ?? null;
  },
  async callClaim(id, user) {
    const r = await rpc<CallRow | null>("wa_call_claim", { p_call: id, p_user: user });
    return r?.id ? r : null;
  },
  callSet: async (id, status, error = null) => { await rpc("wa_call_set", { p_call: id, p_status: status, p_error: error }); },
  callRoute: (op) => rpc("wa_call_route", { p_operator: op }),
  callBotStarted: (op, id, wa, name, room) => rpc<string | null>("wa_call_bot_started", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_room: room }),
  async callByProvider(id) {
    const { data, error } = await db.from("wa_calls").select("*").eq("provider_call_id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { operatorId: data.operator_id, providerCallId: data.provider_call_id, phone: data.phone_e164, waId: data.wa_id, name: data.caller_name,
      status: data.status, handledBy: data.handled_by, endedAt: data.ended_at, conversationId: data.conversation_id } : null;
  },
  callNote: async (id, note, callback) => { await rpc("wa_call_bot_note", { p_call_id: id, p_note: note, p_callback: callback }); },
};

const DESK_ROLES = ["admin", "dispatcher", "agent"];
async function staffOf(userId: string, operatorId: string) {
  const { data } = await db.from("memberships").select("role").eq("operator_id", operatorId).eq("user_id", userId).eq("active", true);
  return (data ?? []).some((r) => DESK_ROLES.includes(r.role));
}
async function staffUser(req: Request) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return null;
  const { data: u } = await db.auth.getUser(bearer);
  return u?.user ?? null;
}

const configured = () => !!(TOKEN && RT.phoneId);
const sender = { send: (to: string, m: Parameters<ReturnType<typeof graphSender>["send"]>[1]) => graphSender(RT.phoneId, TOKEN).send(to, m) };
const ai = env("AI_API_KEY")
  ? makeExtractor({ apiKey: env("AI_API_KEY"), baseUrl: env("AI_BASE_URL") || undefined, model: env("AI_MODEL") || undefined })
  : null;

const assistant = env("AI_API_KEY")
  ? makeAssistant({ apiKey: env("AI_API_KEY"), baseUrl: env("AI_BASE_URL") || undefined, model: env("AI_MODEL") || undefined })
  : null;

const deps: ServiceDeps = {
  db: waDb, store, sender, ai, assistant, log, statusTokenSecret: STATUS_SECRET, publicAppUrl: PUBLIC_APP_URL,
  get templates() { return RT.templates; },
  get calls() { return configured() ? graphCalls(RT.phoneId, TOKEN) : undefined; },
  get voiceBot() {
    return configured() && env("LIVEKIT_URL") && env("LIVEKIT_API_KEY") && env("LIVEKIT_API_SECRET")
      ? liveKitVoiceBot({ url: env("LIVEKIT_URL"), apiKey: env("LIVEKIT_API_KEY"), apiSecret: env("LIVEKIT_API_SECRET"),
          phoneNumberId: RT.phoneId, waToken: TOKEN })
      : undefined;
  },
  voiceSecret: env("VOICE_TOKEN_SECRET") || `voice:${KEY}`,
  voiceToolUrl: `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/whatsapp/voice-tool`,
  async config() {
    const c = await store.loadConfig(SLUG);
    if (!c) throw new Error("operator_not_configured");
    return c;
  },
};

// deno-lint-ignore no-explicit-any
const background = (p: Promise<unknown>) => ((globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(p) : p);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  await refreshRuntime();

  // --- Meta verification handshake
  if (req.method === "GET") {
    const token = env("WHATSAPP_VERIFY_TOKEN");
    if (url.searchParams.get("hub.mode") === "subscribe" && token && url.searchParams.get("hub.verify_token") === token) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });

  // --- Notification worker
  if (path.endsWith("/outbox")) {
    const ok = await rpc<boolean>("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" }).catch(() => false);
    if (!ok) return json(401, { error: { code: "unauthenticated" } });
    if (!configured()) return json(503, { error: { code: "whatsapp_not_configured" } });
    const r = await processOutbox(deps);
    if (r.sent || r.failed) log({ level: "info", outbox: r });
    return json(200, r);
  }

  // --- Voice bot tools (called by the LiveKit agent with the per-call token)
  if (path.endsWith("/voice-tool")) {
    const body = await req.json().catch(() => ({}));
    const cfg = await deps.config();
    const r = await voiceTool({
      cfg, store, now: new Date(), secret: deps.voiceSecret!, statusTokenSecret: STATUS_SECRET, publicAppUrl: PUBLIC_APP_URL,
      call: (id) => waDb.callByProvider(id),
      bookingsForPhone: (phone) => waDb.bookingsForPhone(cfg.operatorId, phone),
      note: (id, note, cb) => waDb.callNote(id, note, cb),
      cancel: (phone, ref, ok) => waDb.passengerCancel!(cfg.operatorId, phone, ref, ok, "voice"),
      transfer: (id, reason) => waDb.callTransferRequest!(id, reason),
      transferFailed: (id) => waDb.callTransferFailed!(id),
      customerContext: (phone) => waDb.customerContext!(cfg.operatorId, phone),
      saveTranscript: (id, t) => waDb.callTranscript!(id, t),
      async sendWhatsApp(call: VoiceCall, m) {
        if (!configured() || !call.conversationId) return false;
        const sent = await sendAndRecord(deps, call.conversationId, call.waId, m);
        return !sent.error;
      },
    }, body ?? {});
    if (r.status >= 400) log({ level: "warn", voiceTool: r.status, action: body?.action });
    return json(r.status, r.body);
  }

  // --- WhatsApp voice call actions from the booking desk
  if (path.endsWith("/call-action")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const body = await req.json().catch(() => ({}));
    const r = await callAction(deps, user.id, (op) => staffOf(user.id, op), body ?? {});
    return json(r.status, r.body);
  }

  // --- WhatsApp connection setup (Graph API with the stored token; the token never leaves the server).
  // Admin login for every step; the outbox key (server-to-server) for the steps that need no code or PIN.
  if (path.endsWith("/setup")) {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "") as SetupAction;
    let userId: string | null = null;
    const user = await staffUser(req);
    if (user) {
      const { data } = await db.from("memberships").select("role").eq("user_id", user.id).eq("active", true).eq("role", "admin");
      if (!data?.length) return json(403, { error: { code: "forbidden" } });
      userId = user.id;
    } else {
      const keyOk = await rpc<boolean>("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" }).catch(() => false);
      if (!keyOk) return json(401, { error: { code: "unauthenticated" } });
      if (!["status", "use_number", "webhook", "calling", "templates"].includes(action)) return json(403, { error: { code: "admin_required" } });
    }
    await refreshRuntime(true);
    const r = await runSetup(action, body?.args ?? {}, {
      token: TOKEN, callbackUrl: `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/whatsapp`,
      verifyToken: env("WHATSAPP_VERIFY_TOKEN"), wabaId: RT.wabaId, phoneNumberId: RT.phoneId,
    }, graph(TOKEN));
    if (r.save) {
      await rpc("wa_runtime_set", { p_phone: r.save.phoneNumberId ?? null, p_waba: r.save.wabaId ?? null,
        p_templates: r.save.templates ?? null, p_user: userId });
      await refreshRuntime(true);
    }
    log({ level: r.ok ? "info" : "warn", setup: action, ok: r.ok, by: userId ? "admin" : "server" });
    return json(r.status, { ...r.body, secrets: { accessToken: !!TOKEN, appSecret: !!env("WHATSAPP_APP_SECRET"), verifyToken: !!env("WHATSAPP_VERIFY_TOKEN"),
      liveKit: !!(env("LIVEKIT_URL") && env("LIVEKIT_API_KEY") && env("LIVEKIT_API_SECRET")), ai: !!env("AI_API_KEY") },
      connected: { phoneNumberId: RT.phoneId || null, wabaId: RT.wabaId || null, templates: Object.keys(RT.templates).length } });
  }

  // --- A desk agent takes a call Sofía is transferring: joins the call's LiveKit room from the browser.
  if (path.endsWith("/call-join")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const lk = { url: env("LIVEKIT_URL"), apiKey: env("LIVEKIT_API_KEY"), apiSecret: env("LIVEKIT_API_SECRET") };
    if (!lk.url || !lk.apiKey || !lk.apiSecret) return json(503, { error: { code: "voice_not_configured" } });
    const body = await req.json().catch(() => ({}));
    const { data: row } = await db.from("wa_calls").select("operator_id").eq("id", String(body?.callId ?? "")).maybeSingle();
    if (!row) return json(404, { error: { code: "call_not_found" } });
    if (!(await staffOf(user.id, row.operator_id))) return json(403, { error: { code: "forbidden" } });
    const c = await waDb.callTransferClaim!(String(body.callId), user.id);
    if (!c || !c.bot_room) return json(409, { error: { code: "transfer_taken" } });
    const token = await mintLiveKitToken({ apiKey: lk.apiKey, apiSecret: lk.apiSecret, identity: `desk-${user.id}`,
      name: `Central (${user.email?.split("@")[0] ?? "staff"})`, room: c.bot_room, canPublish: true, ttlSeconds: 3600, metadata: { kind: "desk" } });
    return json(200, { url: lk.url, token, room: c.bot_room });
  }

  // --- Staff reply from the inbox
  if (path.endsWith("/staff-send")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const u = { user };
    const body = await req.json().catch(() => ({}));
    const text = String(body?.text ?? "").trim();
    if (!body?.conversationId || !text || text.length > 4000) return json(400, { error: { code: "invalid_request" } });
    const { data: c } = await db.from("wa_conversations").select("id, operator_id, wa_id, last_inbound_at").eq("id", body.conversationId).maybeSingle();
    if (!c) return json(404, { error: { code: "conversation_not_found" } });
    if (!(await staffOf(u.user.id, c.operator_id))) return json(403, { error: { code: "forbidden" } });
    if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > 24 * 3600_000) {
      return json(409, { error: { code: "window_closed", message: "Más de 24 h sin mensajes del cliente: WhatsApp sólo permite plantillas aprobadas." } });
    }
    if (!configured()) return json(503, { error: { code: "whatsapp_not_configured" } });
    const r = await sendAndRecord(deps, c.id, c.wa_id, { type: "text", text }, u.user.id);
    return r.error ? json(502, { error: { code: "send_failed", message: r.error } }) : json(200, { id: r.id });
  }

  // --- Meta webhook
  const raw = await req.text();
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret) return json(503, { error: { code: "whatsapp_not_configured" } });
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), secret))) {
    log({ level: "warn", msg: "bad signature" });
    return json(401, { error: { code: "bad_signature" } });
  }
  let parsed;
  try { parsed = parseWebhook(JSON.parse(raw)); } catch { return json(400, { error: { code: "bad_payload" } }); }
  const expected = RT.phoneId;
  if (expected && parsed.phoneNumberId && parsed.phoneNumberId !== expected) return json(200, { ignored: "other_number" });

  // Acknowledge fast (Meta retries slow webhooks); work continues in the background.
  background(processWebhook(parsed, deps).then((r) => r.handled && log({ level: "info", webhook: r }))
    .catch((e) => log({ level: "error", msg: String(e?.message ?? e) })));
  return json(200, { ok: true });
});
