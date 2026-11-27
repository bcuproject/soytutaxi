// Supabase Edge Function `whatsapp` (deploy with --no-verify-jwt; every route authenticates itself).
//   GET  /whatsapp              Meta webhook verification (hub.challenge, WHATSAPP_VERIFY_TOKEN)
//   POST /whatsapp              Meta webhook: X-Hub-Signature-256 checked with WHATSAPP_APP_SECRET
//   POST /whatsapp/outbox       notification worker, called every minute by pg_cron (x-outbox-key)
//   POST /whatsapp/staff-send   staff reply from the inbox (Supabase access token; admin, dispatcher or agent)
//   POST /whatsapp/call-action  answer (SDP), reject or hang up a WhatsApp voice call (same staff check)
//   POST /whatsapp/voice-tool   tools for the voice bot (LiveKit agent on the BCU server), per-call token
// Voice bot secrets: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (same LiveKit project as the agent),
//                    optional VOICE_TOKEN_SECRET.
// Secrets: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN,
//          optional AI_API_KEY (+ AI_BASE_URL, AI_MODEL), WHATSAPP_TEMPLATES (JSON), PUBLIC_APP_URL.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ApiError } from "../_shared/api/store.ts";
import { SupabaseStore } from "../_shared/api/supabaseStore.ts";
import { makeExtractor } from "../_shared/whatsapp/ai.ts";
import { graphCalls, graphSender, parseWebhook, verifySignature } from "../_shared/whatsapp/meta.ts";
import type { NotificationContext, TemplateMap } from "../_shared/whatsapp/notify.ts";
import { liveKitVoiceBot, voiceTool, type VoiceCall } from "../_shared/whatsapp/voice.ts";
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

let templates: TemplateMap = {};
try { templates = JSON.parse(env("WHATSAPP_TEMPLATES") || "{}"); } catch { log({ level: "warn", msg: "WHATSAPP_TEMPLATES is not valid JSON" }); }

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

const configured = () => !!(env("WHATSAPP_ACCESS_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID"));
const sender = graphSender(env("WHATSAPP_PHONE_NUMBER_ID"), env("WHATSAPP_ACCESS_TOKEN"));
const ai = env("AI_API_KEY")
  ? makeExtractor({ apiKey: env("AI_API_KEY"), baseUrl: env("AI_BASE_URL") || undefined, model: env("AI_MODEL") || undefined })
  : null;

const deps: ServiceDeps = {
  db: waDb, store, sender, ai, log, templates, statusTokenSecret: STATUS_SECRET, publicAppUrl: PUBLIC_APP_URL,
  calls: configured() ? graphCalls(env("WHATSAPP_PHONE_NUMBER_ID"), env("WHATSAPP_ACCESS_TOKEN")) : undefined,
  voiceBot: configured() && env("LIVEKIT_URL") && env("LIVEKIT_API_KEY") && env("LIVEKIT_API_SECRET")
    ? liveKitVoiceBot({ url: env("LIVEKIT_URL"), apiKey: env("LIVEKIT_API_KEY"), apiSecret: env("LIVEKIT_API_SECRET"),
        phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), waToken: env("WHATSAPP_ACCESS_TOKEN") })
    : undefined,
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
  const expected = env("WHATSAPP_PHONE_NUMBER_ID");
  if (expected && parsed.phoneNumberId && parsed.phoneNumberId !== expected) return json(200, { ignored: "other_number" });

  // Acknowledge fast (Meta retries slow webhooks); work continues in the background.
  background(processWebhook(parsed, deps).then((r) => r.handled && log({ level: "info", webhook: r }))
    .catch((e) => log({ level: "error", msg: String(e?.message ?? e) })));
  return json(200, { ok: true });
});
