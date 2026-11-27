// Orchestration for the whatsapp Edge Function, independent of Deno: webhook processing (dedupe,
// conversation state with optimistic locking, staff takeover, replies) and the notification outbox.

import type { OperatorConfig } from "../domain/types.ts";
import type { Store } from "../api/store.ts";
import type { Extractor } from "./ai.ts";
import { handleMessage, type BookingSummary, type ConversationState, type Draft, type Step } from "./engine.ts";
import { previewOf, type InboundMessage, type Outbound, type ParsedWebhook, type Sender, type StatusUpdate } from "./meta.ts";
import { composeNotification, type NotificationContext, type TemplateMap } from "./notify.ts";

export interface ConversationRow {
  id: string; operator_id: string; wa_id: string; phone_e164: string; profile_name: string | null;
  kind: "passenger" | "driver"; driver_id: string | null; locale: "es-AR" | "en"; step: string; draft: Draft;
  handoff_owner: string | null; version: number;
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
  outboxClaim(limit: number): Promise<OutboxJob[]>;
  outboxFinish(jobId: string, ok: boolean, error: string | null, final: boolean): Promise<void>;
  notificationContext(kind: string, payload: Record<string, unknown>): Promise<NotificationContext | null>;
  /** Find (or create, without opening the 24 h window) the conversation for an outbound notification. */
  openConversationForNotify(operatorId: string, waId: string): Promise<string | null>;
}

export interface ServiceDeps {
  db: WaDb;
  store: Store;
  sender: Sender;
  config(): Promise<OperatorConfig>;
  ai?: Extractor | null;
  now?: () => Date;
  statusTokenSecret: string;
  publicAppUrl: string;
  templates?: TemplateMap;
  log?: (o: Record<string, unknown>) => void;
}

const kindOf = (m: Outbound) => (m.type === "buttons" || m.type === "list" ? "interactive" : m.type);

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
  if (m.type === "location") return `📍 ${m.location?.name ?? ""} ${m.location?.address ?? ""} (${m.location?.lat.toFixed(5)}, ${m.location?.lng.toFixed(5)})`.trim();
  return `(${m.rawType})`;
}

function sanitize(m: InboundMessage) {
  return { type: m.type, text: m.text, replyId: m.replyId, replyTitle: m.replyTitle, location: m.location, rawType: m.rawType };
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
