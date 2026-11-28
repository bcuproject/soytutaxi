// Orchestration for the whatsapp Edge Function, independent of Deno: webhook processing (dedupe,
// conversation state with optimistic locking, staff takeover, replies) and the notification outbox.

import type { OperatorConfig } from "../domain/types.ts";
import type { CancelTerms, Store } from "../api/store.ts";
import type { Assistant, Extractor } from "./ai.ts";
import type { CustomerContext } from "./facts.ts";
import { handleMessage, type BookingSummary, type ConversationState, type Draft, type Step } from "./engine.ts";
import { previewOf, type CallApi, type InboundMessage, type Outbound, type ParsedWebhook, type Sender, type StatusUpdate } from "./meta.ts";
import { composeNotification, type NotificationContext, type TemplateMap } from "./notify.ts";
import { VOICE_ASSISTANT, voiceToken, type VoiceBot, type VoiceCall } from "./voice.ts";

export interface ConversationRow {
  id: string; operator_id: string; wa_id: string; phone_e164: string; profile_name: string | null;
  kind: "passenger" | "driver"; driver_id: string | null; locale: "es-AR" | "en"; step: string; draft: Draft;
  handoff_owner: string | null; version: number;
}

export interface CallRow {
  id: string; operator_id: string; provider_call_id: string; status: "ringing" | "answering" | "active" | "ended" | "missed" | "rejected" | "failed";
  answered_by: string | null;
}

export interface OutboxJob { id: string; kind: string; payload: Record<string, unknown>; attempts: number }

/** Database operations (implemented with Supabase RPCs in the Edge Function, fakes in tests). */
export interface WaDb {
  openConversation(operatorId: string, waId: string, profileName: string | null): Promise<ConversationRow>;
  saveConversation(id: string, expectedVersion: number, step: string, draft: Draft, locale: string, lastBooking: string | null, needsStaff: boolean | null): Promise<number | null>;
  recordMessage(conversationId: string, direction: "in" | "out", providerId: string | null, kind: string, body: unknown, preview: string, status: string, sentBy?: string | null): Promise<string | null>;
  markSent(messageId: string, providerId: string | null, status: string, error?: string | null): Promise<void>;
  statusUpdate(providerId: string, status: string, error?: string | null): Promise<void>;
  inboxClaim(operatorId: string, eventKey: string): Promise<boolean>;
  inboxDone(eventKey: string): Promise<void>;
  bookingsForPhone(operatorId: string, phone: string): Promise<BookingSummary[]>;
  driverRespond(driverId: string, offerId: string, accept: boolean): Promise<{ outcome: string; reference?: string }>;
  passengerCancel?(operatorId: string, phone: string, reference: string, confirm: boolean, via: "whatsapp" | "voice"): Promise<CancelTerms & { cancelled?: boolean }>;
  rate?(operatorId: string, phone: string, bookingId: string, score: number, comment: string | null): Promise<{ score: number }>;
  outboxClaim(limit: number): Promise<OutboxJob[]>;
  outboxFinish(jobId: string, ok: boolean, error: string | null, final: boolean): Promise<void>;
  notificationContext(kind: string, payload: Record<string, unknown>): Promise<NotificationContext | null>;
  callIncoming(operatorId: string, callId: string, waId: string, name: string | null, sdp: string): Promise<string | null>;
  callTerminated(callId: string, status: string, duration: number | null, error: string | null): Promise<void>;
  callGet(id: string): Promise<CallRow | null>;
  callClaim(id: string, userId: string): Promise<CallRow | null>;
  callSet(id: string, status: CallRow["status"], error?: string | null): Promise<void>;
  callRoute(operatorId: string): Promise<{ mode: "desk" | "bot"; voiceId: string | null }>;
  callBotStarted(operatorId: string, callId: string, waId: string, name: string | null, room: string): Promise<string | null>;
  callByProvider(providerCallId: string): Promise<VoiceCall | null>;
  callNote(providerCallId: string, note: string, callback: boolean): Promise<void>;
  callTransferRequest?(providerCallId: string, reason: string): Promise<{ ok: boolean }>;
  customerContext?(operatorId: string, phone: string): Promise<CustomerContext | null>;
  callTranscript?(providerCallId: string, transcript: string): Promise<void>;
  callTransferFailed?(providerCallId: string): Promise<void>;
  callTransferClaim?(callId: string, userId: string): Promise<{ id: string; operator_id: string; bot_room: string | null; provider_call_id: string } | null>;
  /** Find (or create, without opening the 24 h window) the conversation for an outbound notification. */
  openConversationForNotify(operatorId: string, waId: string): Promise<string | null>;
}

export interface ServiceDeps {
  db: WaDb;
  store: Store;
  sender: Sender;
  calls?: CallApi;
  /** LiveKit WhatsApp connector + agent (voice bot). Absent → calls always ring the Central. */
  voiceBot?: VoiceBot;
  voiceSecret?: string;
  /** Public URL of /whatsapp/voice-tool, handed to the agent. */
  voiceToolUrl?: string;
  config(): Promise<OperatorConfig>;
  ai?: Extractor | null;
  /** Answers free questions from the facts and the customer's memory (needs AI_API_KEY). */
  assistant?: Assistant | null;
  now?: () => Date;
  statusTokenSecret: string;
  publicAppUrl: string;
  templates?: TemplateMap;
  log?: (o: Record<string, unknown>) => void;
}

const kindOf = (m: Outbound) => (m.type === "buttons" || m.type === "list" || m.type === "flow" ? "interactive" : m.type);

/** Send and record one outbound message on a conversation. */
export async function sendAndRecord(deps: ServiceDeps, conversationId: string, to: string, m: Outbound, sentBy: string | null = null) {
  const id = await deps.db.recordMessage(conversationId, "out", null, kindOf(m), m, previewOf(m), "queued", sentBy);
  const r = await deps.sender.send(to, m);
  if (id) await deps.db.markSent(id, r.id ?? null, r.error ? "failed" : "sent", r.error ?? null);
  return r;
}

export async function processWebhook(parsed: ParsedWebhook, deps: ServiceDeps): Promise<{ handled: number; skipped: number }> {
  const log = deps.log ?? (() => {});
  for (const s of parsed.statuses) await applyStatus(deps, s);
  if (parsed.calls.length) {
    const cfg = await deps.config();
    for (const c of parsed.calls) {
      try {
        if (c.event === "connect" && c.from && c.sdp) {
          if (!(await routeToBot(deps, cfg.operatorId, c.id, c.from, c.profileName ?? null, c.sdp, log))) {
            await deps.db.callIncoming(cfg.operatorId, c.id, c.from, c.profileName ?? null, c.sdp);
          }
        } else if (c.event === "terminate") {
          const known = deps.voiceBot ? await deps.db.callByProvider(c.id) : null;
          if (known?.handledBy === "bot") await deps.voiceBot!.disconnect(c.id).catch(() => {});
          await deps.db.callTerminated(c.id, c.status ?? "COMPLETED", c.duration ?? null, c.error ?? null);
        }
      } catch (e) {
        log({ level: "error", where: "wa-call", call: c.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
  }
  let handled = 0, skipped = 0;
  const cfg = parsed.messages.length ? await deps.config() : null;
  for (const msg of parsed.messages) {
    if (!(await deps.db.inboxClaim(cfg!.operatorId, `msg:${msg.id}`))) { skipped++; continue; }   // Meta retries
    try {
      await handleOne(msg, cfg!, deps);
      handled++;
    } catch (e) {
      log({ level: "error", where: "wa-webhook", msg: msg.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
    } finally {
      await deps.db.inboxDone(`msg:${msg.id}`);
    }
  }
  return { handled, skipped };
}

async function applyStatus(deps: ServiceDeps, s: StatusUpdate) {
  await deps.db.statusUpdate(s.id, s.status, s.error ?? null);
}

async function handleOne(msg: InboundMessage, cfg: OperatorConfig, deps: ServiceDeps) {
  const now = deps.now?.() ?? new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await deps.db.openConversation(cfg.operatorId, msg.from, msg.profileName ?? null);
    if (attempt === 0) {
      await deps.db.recordMessage(row.id, "in", msg.id, msg.rawType, sanitize(msg), inboundPreview(msg), "received");
    }
    if (row.handoff_owner) return;   // a person is answering: the bot stays quiet

    const conv: ConversationState = {
      id: row.id, operatorId: row.operator_id, waId: row.wa_id, profileName: row.profile_name, kind: row.kind,
      driverId: row.driver_id, locale: row.locale, step: (row.step as Step) ?? "menu", draft: row.draft ?? {},
    };
    const r = await handleMessage(conv, msg, {
      cfg, now, store: deps.store, ai: deps.ai ?? null, statusTokenSecret: deps.statusTokenSecret, publicAppUrl: deps.publicAppUrl,
      bookingsForPhone: (phone) => deps.db.bookingsForPhone(cfg.operatorId, phone),
      driverRespond: (d, o, a) => deps.db.driverRespond(d, o, a),
      cancelBooking: deps.db.passengerCancel ? (phone, ref, ok) => deps.db.passengerCancel!(cfg.operatorId, phone, ref, ok, "whatsapp") : undefined,
      rate: deps.db.rate ? (phone, id, n, c) => deps.db.rate!(cfg.operatorId, phone, id, n, c) : undefined,
      assistant: deps.assistant ?? null,
      customerContext: deps.db.customerContext ? (phone) => deps.db.customerContext!(cfg.operatorId, phone) : undefined,
      dateFlowId: deps.templates?.["flow.datetime"]?.name ?? null,
    });
    const saved = await deps.db.saveConversation(row.id, row.version, r.step, r.draft, r.locale, r.bookingId ?? null, r.needsStaff ? true : null);
    if (saved === null) continue;    // another message for this chat was processed meanwhile → redo with fresh state
    for (const m of r.replies) await sendAndRecord(deps, row.id, row.wa_id, m);
    return;
  }
  throw new Error("conversation_busy");
}

function inboundPreview(m: InboundMessage) {
  if (m.type === "text") return m.text ?? "";
  if (m.type === "reply") return `▸ ${m.replyTitle ?? m.replyId}`;
  if (m.type === "flow") return `📅 ${Object.values(m.flow ?? {}).join(" ")}`.trim();
  if (m.type === "location") return `📍 ${m.location?.name ?? ""} ${m.location?.address ?? ""} (${m.location?.lat.toFixed(5)}, ${m.location?.lng.toFixed(5)})`.trim();
  return `(${m.rawType})`;
}

function sanitize(m: InboundMessage) {
  return { type: m.type, text: m.text, replyId: m.replyId, replyTitle: m.replyTitle, location: m.location, flow: m.flow, rawType: m.rawType };
}

/** Drain notification jobs. Conversations for the recipient are opened so the message shows in the dispatch inbox. */
export async function processOutbox(deps: ServiceDeps, limit = 20): Promise<{ sent: number; skipped: number; failed: number }> {
  const cfg = await deps.config();
  const now = deps.now?.() ?? new Date();
  const jobs = await deps.db.outboxClaim(limit);
  let sent = 0, skipped = 0, failed = 0;
  for (const job of jobs) {
    try {
      const ctx = await deps.db.notificationContext(job.kind, job.payload);
      const c = await composeNotification(job.kind, ctx, {
        now, timezone: cfg.timezone, publicAppUrl: deps.publicAppUrl, statusTokenSecret: deps.statusTokenSecret, templates: deps.templates ?? {},
      });
      if (!c.send) { await deps.db.outboxFinish(job.id, true, c.reason, false); skipped++; continue; }   // nothing to send: close the job, keep the reason
      const conv = await deps.db.openConversationForNotify(cfg.operatorId, c.to);
      const r = conv
        ? await sendAndRecord(deps, conv, c.to, c.message)
        : await deps.sender.send(c.to, c.message);
      if (r.error) {
        // 4xx from Meta (bad number, template rejected) won't fix itself; network/5xx are retried.
        const permanent = /^4\d\d /.test(r.error) && !/^429 /.test(r.error);
        await deps.db.outboxFinish(job.id, false, r.error, permanent);
        failed++;
      } else { await deps.db.outboxFinish(job.id, true, null, false); sent++; }
    } catch (e) {
      await deps.db.outboxFinish(job.id, false, String((e as Error)?.message ?? e).slice(0, 300), false);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

export type CallActionResult = { status: number; body: Record<string, unknown> };

/**
 * Staff action on a WhatsApp call. accept: claim the ringing call (one agent wins), then pre-accept and
 * accept with the browser's SDP answer; reject: decline a ringing call; terminate: hang up.
 */
export async function callAction(
  deps: ServiceDeps, userId: string, isStaffOf: (operatorId: string) => Promise<boolean>,
  input: { callId?: unknown; action?: unknown; sdp?: unknown },
): Promise<CallActionResult> {
  const api = deps.calls;
  if (!api) return { status: 503, body: { error: { code: "whatsapp_not_configured" } } };
  const id = String(input.callId ?? "");
  const action = String(input.action ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id) || !["accept", "reject", "terminate"].includes(action)) return { status: 400, body: { error: { code: "invalid_request" } } };
  const call = await deps.db.callGet(id);
  if (!call) return { status: 404, body: { error: { code: "call_not_found" } } };
  if (!(await isStaffOf(call.operator_id))) return { status: 403, body: { error: { code: "forbidden" } } };

  if (action === "accept") {
    const sdp = String(input.sdp ?? "");
    if (!sdp.startsWith("v=0") || sdp.length > 20_000) return { status: 400, body: { error: { code: "invalid_sdp" } } };
    const claimed = await deps.db.callClaim(id, userId);
    if (!claimed) return { status: 409, body: { error: { code: call.status === "ringing" ? "call_taken" : `call_${call.status}` } } };
    const pre = await api.action(call.provider_call_id, "pre_accept", sdp);
    const acc = pre.ok ? await api.action(call.provider_call_id, "accept", sdp) : pre;
    if (!acc.ok) {
      await deps.db.callSet(id, "failed", acc.error ?? "accept_failed");
      return { status: 502, body: { error: { code: "accept_failed", message: acc.error } } };
    }
    await deps.db.callSet(id, "active");
    return { status: 200, body: { status: "active" } };
  }
  if (action === "reject") {
    if (call.status !== "ringing") return { status: 409, body: { error: { code: `call_${call.status}` } } };
    const r = await api.action(call.provider_call_id, "reject");
    await deps.db.callSet(id, "rejected", r.ok ? null : r.error);
    return { status: 200, body: { status: "rejected" } };
  }
  // terminate
  if (!["answering", "active"].includes(call.status)) return { status: 409, body: { error: { code: `call_${call.status}` } } };
  const r = await api.action(call.provider_call_id, "terminate");
  await deps.db.callSet(id, "ended", r.ok ? null : r.error);
  return { status: 200, body: { status: "ended" } };
}

/** Voice bot answers when the Central chose "Bot" and LiveKit is configured; any failure rings the Central instead. */
async function routeToBot(deps: ServiceDeps, operatorId: string, callId: string, waId: string, name: string | null, sdp: string,
  log: (o: Record<string, unknown>) => void): Promise<boolean> {
  if (!deps.voiceBot || !deps.voiceSecret || !deps.voiceToolUrl) return false;
  const route = await deps.db.callRoute(operatorId);
  if (route.mode !== "bot") return false;
  const room = `stt-call-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const phone = `+${waId.replace(/\D/g, "")}`;
  try {
    await deps.voiceBot.accept({ callId, sdp, room, callerPhone: phone, attributes: {
      bcu_assistant: VOICE_ASSISTANT, caller_phone: phone, caller_name: name ?? "", wa_call_id: callId,
      stt_token: await voiceToken(deps.voiceSecret, callId), stt_api: deps.voiceToolUrl, stt_voice: route.voiceId ?? "",
    } });
    await deps.db.callBotStarted(operatorId, callId, waId, name, room);
    return true;
  } catch (e) {
    log({ level: "error", where: "wa-voice-bot", call: callId, error: String((e as Error)?.message ?? e).slice(0, 300) });
    return false;
  }
}
