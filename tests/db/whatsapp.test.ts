// WhatsApp end to end against PostgreSQL: webhook → conversation → booking, notifications outbox,
// staff takeover, permissions. The RPC helper uses the same named arguments as the Edge Function.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_OPERATOR_ID, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import type { Outbound, ParsedWebhook, Sender } from "@shared/whatsapp/meta.ts";
import { callAction, processOutbox, processWebhook, type ServiceDeps, type WaDb } from "@shared/whatsapp/service.ts";
import { parseWebhook, type CallApi } from "@shared/whatsapp/meta.ts";
import { DB_URL, PgStore } from "./pgStore.ts";
import { ApiError } from "@shared/api/store.ts";

let pool: pg.Pool;
const DISPATCHER = DEMO_STAFF[1].userId;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);

async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
  try {
    const rows = await q(sql, vals);
    return rows[0].r as T;
  } catch (e: any) {
    if (/^[a-z_]+$/.test(e.message)) throw new ApiError(Number(e.detail) || 400, e.message, e.hint ?? e.message);
    throw e;
  }
}

const waDb: WaDb = {
  openConversation: async (op, wa, name) => (await q("select (public.wa_open_conversation(p_operator => $1, p_wa_id => $2, p_profile_name => $3)).*", [op, wa, name]))[0],
  saveConversation: (id, v, step, draft, locale, lastBooking, needsStaff) =>
    rpc("wa_save_conversation", { p_id: id, p_expected_version: v, p_step: step, p_draft: draft, p_locale: locale, p_last_booking: lastBooking, p_needs_staff: needsStaff }),
  recordMessage: (c, dir, pid, kind, body, preview, status, sentBy = null) =>
    rpc("wa_record_message", { p_conversation: c, p_direction: dir, p_provider_id: pid, p_kind: kind, p_body: body, p_preview: preview, p_status: status, p_sent_by: sentBy }),
  markSent: (id, pid, status, error = null) => rpc("wa_mark_sent", { p_message: id, p_provider_id: pid, p_status: status, p_error: error }),
  statusUpdate: (pid, status, error = null) => rpc("wa_status_update", { p_provider_id: pid, p_status: status, p_error: error }),
  inboxClaim: (op, key) => rpc("wa_inbox_claim", { p_operator: op, p_event_key: key }),
  inboxDone: (key) => rpc("wa_inbox_done", { p_event_key: key }),
  bookingsForPhone: (op, phone) => rpc("wa_bookings_for_phone", { p_operator: op, p_phone: phone }),
  driverRespond: (d, o, a) => rpc("wa_driver_respond", { p_driver: d, p_offer: o, p_accept: a }),
  callTransferRequest: (id, reason) => rpc("wa_call_transfer_request", { p_call_id: id, p_reason: reason }),
  customerContext: (op, phone) => rpc("wa_customer_context", { p_operator: op, p_phone: phone }),
  callTranscript: (id, t) => rpc("wa_call_transcript", { p_call_id: id, p_transcript: t }),
  callTransferFailed: (id) => rpc("wa_call_transfer_failed", { p_call_id: id }),
  passengerCancel: (op, phone, ref, ok, via) => rpc("wa_passenger_cancel", { p_operator: op, p_phone: phone, p_reference: ref, p_confirm: ok, p_via: via }),
  rate: (op, phone, id, n, c) => rpc("wa_rate", { p_operator: op, p_phone: phone, p_booking: id, p_score: n, p_comment: c }),
  outboxClaim: async (limit) => q("select * from public.wa_outbox_claim(p_limit => $1)", [limit]),
  outboxFinish: (job, ok, error, final) => rpc("wa_outbox_finish", { p_job: job, p_ok: ok, p_error: error, p_final: final }),
  notificationContext: (kind, payload) => rpc("wa_notification_context", { p_kind: kind, p_payload: payload }),
  openConversationForNotify: (op, wa) => rpc("wa_open_conversation_for_notify", { p_operator: op, p_wa_id: wa }),
  callIncoming: (op, id, wa, name, sdp) => rpc("wa_call_incoming", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_sdp: sdp }),
  callTerminated: (id, status, duration, error) => rpc("wa_call_terminated", { p_call_id: id, p_status: status, p_duration: duration, p_error: error }),
  callGet: async (id) => (await q("select * from wa_calls where id = $1", [id]))[0] ?? null,
  callClaim: async (id, user) => { const r = (await q("select (c).* from (select public.wa_call_claim(p_call => $1, p_user => $2) as c) t", [id, user]))[0]; return r?.id ? r : null; },
  callSet: async (id, status, error = null) => { await rpc("wa_call_set", { p_call: id, p_status: status, p_error: error }); },
  callRoute: (op) => rpc("wa_call_route", { p_operator: op }),
  callBotStarted: (op, id, wa, name, room) => rpc("wa_call_bot_started", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_room: room }),
  callByProvider: async (id) => {
    const r = (await q("select * from wa_calls where provider_call_id = $1", [id]))[0];
    return r ? { operatorId: r.operator_id, providerCallId: r.provider_call_id, phone: r.phone_e164, waId: r.wa_id, name: r.caller_name,
      status: r.status, handledBy: r.handled_by, endedAt: r.ended_at?.toISOString?.() ?? r.ended_at, conversationId: r.conversation_id } : null;
  },
  callNote: async (id, note, callback) => { await rpc("wa_call_bot_note", { p_call_id: id, p_note: note, p_callback: callback }); },
};

const sent: { to: string; m: Outbound }[] = [];
let n = 0;
const sender: Sender = { async send(to, m) { sent.push({ to, m }); return { id: `wamid.out${++n}` }; } };
let deps: ServiceDeps;
let seq = 0;

const PAX = "447700900555";
const hook = (m: Record<string, unknown>, from = PAX, name = "Grace Hopper"): ParsedWebhook => ({
  phoneNumberId: "1", statuses: [], calls: [],
  messages: [{ id: `wamid.in${++seq}`, from, profileName: name, timestamp: 0, rawType: "text", type: "text", ...m } as any],
});
const say = (text: string, from?: string) => processWebhook(hook({ type: "text", text }, from), deps);
const tap = (id: string, from?: string) => processWebhook(hook({ type: "reply", replyId: id, replyTitle: id, rawType: "interactive" }, from), deps);
const lastText = () => { const m = sent.at(-1)!.m; return "text" in m ? m.text : ""; };
const conv = async (wa = PAX) => (await q("select * from wa_conversations where wa_id = $1", [wa]))[0];

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  await q(`insert into auth.users (id, email) values ($1,$2)`, [DISPATCHER, DEMO_STAFF[1].email]);
  await q("select app.grant_role_by_email('soytutaxi', $1, 'dispatcher')", [DEMO_STAFF[1].email]);
  const store = new PgStore(pool);
  deps = {
    db: waDb, store, sender, statusTokenSecret: "test-secret", publicAppUrl: "https://example.test",
    config: async () => (await store.loadConfig("soytutaxi"))!,
  };
});
afterAll(async () => { await pool?.end(); });

describe("WhatsApp webhook → booking (database)", () => {
  it("books a transfer through the chat and stores the conversation", async () => {
    await say("Hola, necesito ir de Recoleta a Aeroparque pasado mañana a las 08:00, somos 2 con 2 valijas y 1 de mano");
    expect(lastText() || JSON.stringify(sent.at(-1)!.m)).toContain("Recoleta");          // asks for the address
    await say("Av. Alvear 1891");
    const review = sent.at(-1)!.m as Extract<Outbound, { type: "buttons" }>;
    expect(review.text).toContain("Revisá tu viaje");
    await tap("review:confirm");
    await tap("name:profile");
    await tap("pay:pay_on_pickup_cash");
    expect(lastText()).toMatch(/STT-[A-Z0-9]{6}/);
    const ref = lastText().match(/STT-[A-Z0-9]{6}/)![0];
    const [b] = await q("select b.*, p.phone_e164, p.full_name from bookings b join passengers p on p.id = b.passenger_id where reference = $1", [ref]);
    expect(b).toMatchObject({ source: "whatsapp", state: "needs_driver", phone_e164: "+447700900555", full_name: "Grace Hopper", payment_mode: "pay_on_pickup_cash" });
    const c = await conv();
    expect(c).toMatchObject({ step: "done", kind: "passenger", last_booking_id: b.id });
    const msgs = await q("select direction, status from wa_messages where conversation_id = $1 order by created_at", [c.id]);
    expect(msgs.filter((m) => m.direction === "in")).toHaveLength(5);
    expect(msgs.filter((m) => m.direction === "out").every((m) => m.status === "sent")).toBe(true);
  });

  it("Meta retries of the same message are processed once", async () => {
    const h = hook({ type: "text", text: "mi reserva" });
    const before = sent.length;
    expect(await processWebhook(h, deps)).toEqual({ handled: 1, skipped: 0 });
    expect(await processWebhook(h, deps)).toEqual({ handled: 0, skipped: 1 });
    expect(sent.length).toBe(before + 2);              // the list + a "Cancel STT-…" button (open booking)
    expect(JSON.stringify(sent.slice(-2))).toContain("bk:cancel:STT-");
  });

  it("delivery receipts never move a message backwards", async () => {
    const [m] = await q("select provider_message_id from wa_messages where direction = 'out' and status = 'sent' limit 1");
    await waDb.statusUpdate(m.provider_message_id, "read");
    await waDb.statusUpdate(m.provider_message_id, "delivered");
    expect((await q("select status from wa_messages where provider_message_id = $1", [m.provider_message_id]))[0].status).toBe("read");
  });

  it("stale conversation versions are rejected (optimistic lock)", async () => {
    const c = await conv();
    expect(await waDb.saveConversation(c.id, c.version - 1, "menu", {}, "es-AR", null, null)).toBeNull();
    expect(await waDb.saveConversation(c.id, c.version, c.step, c.draft, c.locale, null, null)).toBe(c.version + 1);
  });

  it("when staff take over, the bot stays quiet; handing back resets to the menu", async () => {
    const c = await conv();
    const take = async (t: boolean) => {
      const cl = await pool.connect();
      try {
        await cl.query("begin"); await cl.query("set local role authenticated");
        await cl.query("select set_config('request.jwt.claim.sub', $1, true)", [DISPATCHER]);
        const r = await cl.query("select dispatch_wa_takeover($1, $2) as r", [c.id, t]);
        await cl.query("commit"); return r.rows[0].r;
      } catch (e) { await cl.query("rollback"); throw e; } finally { cl.release(); }
    };
    await take(true);
    const before = sent.length;
    await say("hola? necesito cambiar la hora");
    expect(sent.length).toBe(before);
    expect((await q("select count(*)::int as n from wa_messages where conversation_id = $1 and preview like 'hola? necesito%'", [c.id]))[0].n).toBe(1);
    await take(false);
    expect(await conv()).toMatchObject({ handoff_owner: null, step: "menu" });
  });

  it("drivers' verified numbers are recognised and can accept offers by button", async () => {
    const [b] = await q("select id, reference from bookings where reference = 'STT-DEM004'");
    const did = "f6666666-0000-4000-8000-000000000003";   // Diego, sedan
    await q(`insert into driver_availability (operator_id, driver_id, kind, during) values ($1, $2, 'available', tstzrange(now() - interval '1 day', now() + interval '10 days', '[)'))`, [DEMO_OPERATOR_ID, did]);
    const [o] = await q(`insert into booking_offers (operator_id, booking_id, driver_id, vehicle_id, generation, expires_at, earnings_minor, earnings_currency)
      select operator_id, id, $2, app.driver_vehicle_at($2, agreed_pickup_at), offer_generation, now() + interval '10 minutes', 2400, currency from bookings where id = $1 returning id`, [b.id, did]);
    await say("hola", "5491100000003");
    expect((await conv("5491100000003")).kind).toBe("driver");
    await tap(`offer:${o.id}:a`, "5491100000003");
    expect(lastText()).toContain("STT-DEM004");
    expect((await q("select state from bookings where id = $1", [b.id]))[0].state).not.toBe("needs_driver");
  });
});

describe("Notifications outbox (database)", () => {
  it("confirmed and cancelled notices go to passengers inside the 24 h window; others are closed with a reason", async () => {
    await q("update outbox_jobs set state = 'done' where kind like 'notify.%'");
    const [b] = await q("select b.id from bookings b join passengers p on p.id = b.passenger_id where p.phone_e164 = '+447700900555'");
    await q("insert into outbox_jobs (operator_id, kind, dedupe_key, payload) values ($1, 'notify.passenger.cancelled', 'x1', jsonb_build_object('booking_id', $2::uuid))", [DEMO_OPERATOR_ID, b.id]);
    // Passenger with no WhatsApp chat → outside the window and no template configured.
    const [d] = await q("select id from bookings where reference = 'STT-DEM002'");
    await q("insert into outbox_jobs (operator_id, kind, dedupe_key, payload) values ($1, 'notify.passenger.confirmed', 'x2', jsonb_build_object('booking_id', $2::uuid))", [DEMO_OPERATOR_ID, d.id]);
    const before = sent.length;
    expect(await processOutbox(deps)).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.to).toBe(PAX);
    expect(lastText()).toContain("cancelada");
    const jobs = await q("select dedupe_key, state, last_error from outbox_jobs where dedupe_key in ('x1','x2') order by dedupe_key");
    expect(jobs).toEqual([{ dedupe_key: "x1", state: "done", last_error: null }, { dedupe_key: "x2", state: "done", last_error: "no_template" }]);
  });

  it("uses an approved template outside the window when one is configured", async () => {
    deps.templates = { "notify.passenger.confirmed": { name: "trip_confirmed", language: "es_AR" } };
    const [d] = await q("select id from bookings where reference = 'STT-DEM002'");
    await q("insert into outbox_jobs (operator_id, kind, dedupe_key, payload) values ($1, 'notify.passenger.confirmed', 'x3', jsonb_build_object('booking_id', $2::uuid))", [DEMO_OPERATOR_ID, d.id]);
    await processOutbox(deps);
    const m = sent.at(-1)!.m as Extract<Outbound, { type: "template" }>;
    expect(m).toMatchObject({ type: "template", name: "trip_confirmed", language: "es_AR" });
    expect(m.params[0]).toBe("STT-DEM002");
    expect(sent.at(-1)!.to).toBe("5491155550002");
    // The notice appears in the dispatch inbox under a conversation that did NOT open the 24 h window.
    expect(await conv("5491155550002")).toMatchObject({ last_inbound_at: null });
    deps.templates = {};
  });

  it("failed sends back off and retry; 4xx errors are final", async () => {
    const failing: Sender = { async send() { return { error: "503 upstream" }; } };
    const [b] = await q("select b.id from bookings b join passengers p on p.id = b.passenger_id where p.phone_e164 = '+447700900555'");
    await q("insert into outbox_jobs (operator_id, kind, dedupe_key, payload) values ($1, 'notify.passenger.cancelled', 'x4', jsonb_build_object('booking_id', $2::uuid))", [DEMO_OPERATOR_ID, b.id]);
    await processOutbox({ ...deps, sender: failing });
    let [j] = await q("select state, attempts, next_attempt_at > now() + interval '30 seconds' as later from outbox_jobs where dedupe_key = 'x4'");
    expect(j).toMatchObject({ state: "pending", attempts: 1, later: true });
    await q("update outbox_jobs set next_attempt_at = now() where dedupe_key = 'x4'");
    await processOutbox({ ...deps, sender: { async send() { return { error: "400 131026 Message undeliverable" }; } } });
    [j] = await q("select state from outbox_jobs where dedupe_key = 'x4'");
    expect(j.state).toBe("dead");
  });
});

describe("WhatsApp permissions", () => {
  it("service functions are closed to browsers; the outbox key is checked; staff can read the inbox", async () => {
    for (const role of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query("begin"); await c.query(`set local role ${role}`);
        await expect(c.query("select wa_open_conversation($1, '5491100000099', null)", [DEMO_OPERATOR_ID])).rejects.toThrow(/permission denied/);
      } finally { await c.query("rollback"); c.release(); }
    }
    const [{ value: key }] = await q("select value from app.private_settings where key = 'outbox_key'");
    expect(await rpc("wa_outbox_key_ok", { p_key: key })).toBe(true);
    expect(await rpc("wa_outbox_key_ok", { p_key: "x".repeat(64) })).toBe(false);
    expect(await rpc("wa_outbox_key_ok", { p_key: "" })).toBe(false);
    await q("select app.kick_whatsapp_outbox()");   // no functions_url yet → harmless no-op

    const read = async (sub: string | null) => {
      const c = await pool.connect();
      try {
        await c.query("begin"); await c.query("set local role authenticated");
        if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
        return (await c.query("select count(*)::int as n from wa_messages")).rows[0].n;
      } finally { await c.query("rollback"); c.release(); }
    };
    expect(await read(DISPATCHER)).toBeGreaterThan(5);
    expect(await read("00000000-0000-4000-8000-0000000000aa")).toBe(0);
  });
});

describe("WhatsApp calls through the webhook (database)", () => {
  const AGENT2 = "77777777-0000-4000-8000-000000000002";
  const actions: string[] = [];
  const api: CallApi = { async action(id, a, sdp) { actions.push(`${a}:${id}${sdp ? ":sdp" : ""}`); return { ok: true }; } };
  const callHook = (calls: unknown[]) => parseWebhook({ entry: [{ changes: [{ field: "calls", value: {
    metadata: { phone_number_id: "1" }, contacts: [{ wa_id: "5491155557777", profile: { name: "Caller Uno" } }], calls } }] }] });

  it("rings, is answered by exactly one agent, then hangs up", async () => {
    await processWebhook(callHook([{ id: "wacid.X1", from: "5491155557777", to: "1", event: "connect", timestamp: "1", direction: "USER_INITIATED",
      session: { sdp_type: "offer", sdp: "v=0\r\no=- offer" } }]), deps);
    const [c] = await q("select * from wa_calls where provider_call_id = 'wacid.X1'");
    expect(c).toMatchObject({ status: "ringing", caller_name: "Caller Uno", phone_e164: "+5491155557777" });
    const d = { ...deps, calls: api };
    const staff = async () => true;
    const [r1, r2] = await Promise.all([
      callAction(d, DISPATCHER, staff, { callId: c.id, action: "accept", sdp: "v=0\r\nanswer" }),
      callAction(d, AGENT2, staff, { callId: c.id, action: "accept", sdp: "v=0\r\nanswer" }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(actions).toEqual(["pre_accept:wacid.X1:sdp", "accept:wacid.X1:sdp"]);
    expect((await q("select status, connected_at is not null as c from wa_calls where id = $1", [c.id]))[0]).toEqual({ status: "active", c: true });
    expect((await callAction(d, DISPATCHER, staff, { callId: c.id, action: "terminate" })).status).toBe(200);
    expect(actions.at(-1)).toBe("terminate:wacid.X1");
    await processWebhook(callHook([{ id: "wacid.X1", event: "terminate", status: "COMPLETED", duration: 42 }]), deps);
    expect((await q("select status, duration_s from wa_calls where id = $1", [c.id]))[0]).toEqual({ status: "ended", duration_s: 42 });
  });

  it("refuses outsiders, bad input, and declining a call already answered", async () => {
    await processWebhook(callHook([{ id: "wacid.X2", from: "5491155557777", event: "connect", session: { sdp_type: "offer", sdp: "v=0 x" } }]), deps);
    const [c] = await q("select id from wa_calls where provider_call_id = 'wacid.X2'");
    const d = { ...deps, calls: api };
    expect((await callAction(d, DISPATCHER, async () => false, { callId: c.id, action: "accept", sdp: "v=0" })).status).toBe(403);
    expect((await callAction(d, DISPATCHER, async () => true, { callId: c.id, action: "accept", sdp: "<script>" })).status).toBe(400);
    expect((await callAction(d, DISPATCHER, async () => true, { callId: c.id, action: "explode" })).status).toBe(400);
    expect((await callAction(d, DISPATCHER, async () => true, { callId: c.id, action: "reject" })).body).toEqual({ status: "rejected" });
    expect((await callAction(d, DISPATCHER, async () => true, { callId: c.id, action: "reject" })).status).toBe(409);
    expect((await callAction({ ...deps, calls: undefined }, DISPATCHER, async () => true, { callId: c.id, action: "reject" })).status).toBe(503);
  });
});

describe("Voice bot (database)", () => {
  const accepted: any[] = [];
  const disconnected: string[] = [];
  const bot = {
    async accept(a: any) { if (a.callerPhone === "+5491100009999") throw new Error("livekit down"); accepted.push(a); },
    async disconnect(id: string) { disconnected.push(id); },
  };
  const vdeps = () => ({ ...deps, voiceBot: bot, voiceSecret: "voice-secret", voiceToolUrl: "https://x/functions/v1/whatsapp/voice-tool" });
  const callHook = (calls: unknown[], name = "Voz Cliente") => parseWebhook({ entry: [{ changes: [{ field: "calls", value: {
    metadata: { phone_number_id: "1" }, contacts: [{ wa_id: String((calls[0] as any).from ?? ""), profile: { name } }], calls } }] }] });
  const setMode = (mode: string) => q("insert into desk_settings (operator_id, call_mode) values ($1, $2) on conflict (operator_id) do update set call_mode = excluded.call_mode", [DEMO_OPERATOR_ID, mode]);
  let tool: (action: string, args?: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<{ status: number; body: any }>;

  beforeAll(async () => {
    const { voiceTool, voiceToken } = await import("@shared/whatsapp/voice.ts");
    const store = new PgStore(pool);
    tool = async (action, args = {}, extra = {}) => voiceTool({
      cfg: (await store.loadConfig("soytutaxi"))!, store, now: new Date(), secret: "voice-secret", statusTokenSecret: "s", publicAppUrl: "https://example.test",
      call: (id) => waDb.callByProvider(id), bookingsForPhone: (p) => waDb.bookingsForPhone(DEMO_OPERATOR_ID, p),
      note: (id, n, cb) => waDb.callNote(id, n, cb),
      transfer: (id, r) => waDb.callTransferRequest!(id, r), transferFailed: (id) => waDb.callTransferFailed!(id),
      cancel: (phone, ref, ok) => waDb.passengerCancel!(DEMO_OPERATOR_ID, phone, ref, ok, "voice"),
      customerContext: (phone) => waDb.customerContext!(DEMO_OPERATOR_ID, phone), saveTranscript: (id, t) => waDb.callTranscript!(id, t),
      sendWhatsApp: async (c, m) => { sent.push({ to: c.waId, m }); return true; },
    }, { callId: "wacid.V1", token: await voiceToken("voice-secret", "wacid.V1"), action, args, ...extra });
  });

  it("desk mode keeps ringing the Central", async () => {
    await setMode("desk");
    await processWebhook(callHook([{ id: "wacid.V0", from: "5491100008888", event: "connect", session: { sdp_type: "offer", sdp: "v=0 a" } }]), vdeps());
    expect(accepted).toHaveLength(0);
    expect((await q("select status, handled_by from wa_calls where provider_call_id = 'wacid.V0'"))[0]).toEqual({ status: "ringing", handled_by: "desk" });
  });

  it("bot mode hands the call to the LiveKit agent with a per-call token; LiveKit failure falls back to the Central", async () => {
    await setMode("bot");
    await processWebhook(callHook([{ id: "wacid.V1", from: "5491100007777", event: "connect", session: { sdp_type: "offer", sdp: "v=0 b" } }]), vdeps());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].attributes).toMatchObject({ bcu_assistant: "soytutaxi", caller_phone: "+5491100007777", wa_call_id: "wacid.V1", caller_name: "Voz Cliente",
      stt_api: "https://x/functions/v1/whatsapp/voice-tool" });
    expect(accepted[0].attributes.stt_token.length).toBeGreaterThan(20);
    expect((await q("select status, handled_by, offer_sdp from wa_calls where provider_call_id = 'wacid.V1'"))[0]).toEqual({ status: "active", handled_by: "bot", offer_sdp: null });

    await processWebhook(callHook([{ id: "wacid.V2", from: "5491100009999", event: "connect", session: { sdp_type: "offer", sdp: "v=0 c" } }]), vdeps());
    expect((await q("select status, handled_by from wa_calls where provider_call_id = 'wacid.V2'"))[0]).toEqual({ status: "ringing", handled_by: "desk" });
  });

  it("tools: config, quote, book (WhatsApp sent, phone from the call), bookings, callback note", async () => {
    const cfg = await tool("config");
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ callerName: "Voz Cliente", callerPhoneLast4: "7777" });
    expect(cfg.body.zones.map((z: any) => z.code)).toContain("palermo");
    expect(cfg.body.rules.leadTimeHours).toBe(3);

    const date = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    const bad = await tool("quote", { direction: "to_airport", airport: "AEP", zone: "Narnia", address: "x", date, time: "09:00", passengers: 2, largeBags: 1 });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.problems.join(" ")).toContain("zona");

    const quote = await tool("quote", { direction: "to_airport", airport: "AEP", zone: "Recoleta", address: "Av. Alvear 1891", date, time: "09:00", passengers: 2, largeBags: 2, carryOn: 1 });
    expect(quote.body).toMatchObject({ ok: true, vehicle: "Sedán Premium" });
    expect(quote.body.price).toMatch(/USD/);

    const booked = await tool("book", { quoteId: quote.body.quoteId, name: "Voz Cliente", paymentMode: "pay_on_pickup_cash", phone: "+999 (ignored)" });
    expect(booked.body).toMatchObject({ ok: true, whatsappSent: true });
    expect(booked.body.spoken).toMatch(/^S T T, /);
    const [b] = await q("select b.source, p.phone_e164 from bookings b join passengers p on p.id = b.passenger_id where b.reference = $1", [booked.body.reference]);
    expect(b).toEqual({ source: "voice", phone_e164: "+5491100007777" });
    expect((sent.at(-1)!.m as any).text).toContain(booked.body.reference);
    // Same quote again (the bot retried) → same booking, no second WhatsApp.
    const before = sent.length;
    expect((await tool("book", { quoteId: quote.body.quoteId, name: "Voz Cliente", paymentMode: "pay_on_pickup_cash" })).body.reference).toBe(booked.body.reference);
    expect(sent.length).toBe(before);

    expect((await tool("bookings")).body.bookings[0]).toMatchObject({ reference: booked.body.reference, state: "buscando chofer" });
    // Cancel by voice: terms first, then confirmed.
    const terms = await tool("cancel", { reference: booked.body.reference, confirm: false });
    expect(terms.body).toMatchObject({ ok: true, needsConfirm: true });
    expect((await tool("cancel", { reference: booked.body.reference, confirm: true })).body).toMatchObject({ ok: true, cancelled: true });
    expect((await tool("cancel", { reference: "STT-ZZZZZZ", confirm: true })).body.ok).toBe(false);
    // Transfer to a person, then it times out → callback request.
    expect((await tool("transfer", { reason: "Quiere hablar con alguien" })).body).toMatchObject({ ok: true, waitSeconds: 45 });
    await tool("transfer_failed");
    expect((await q("select wants_callback, transfer_failed_at is not null f from wa_calls where provider_call_id = 'wacid.V1'"))[0]).toEqual({ wants_callback: true, f: true });
    await q("update wa_calls set wants_callback = false, bot_note = null where provider_call_id = 'wacid.V1'");

    // Memory: the transcript is saved, and the next call (and the WhatsApp assistant) sees calls, chat and bookings.
    await tool("transcript", { transcript: "Sofía: ¡Hola!\nCliente: Quiero saber si hay silla de bebé" });
    const phone = (await q("select phone_e164 from wa_calls where provider_call_id = 'wacid.V1'"))[0].phone_e164;
    const mem = await waDb.customerContext!(DEMO_OPERATOR_ID, phone);
    expect(mem!.calls.at(-1)).toMatchObject({ handledBy: "Sofía (bot)", transcript: expect.stringContaining("silla de bebé") });
    expect(mem!.bookings.map((b) => b.reference)).toContain(booked.body.reference);
    expect(mem!.bookings.find((b) => b.reference === booked.body.reference)!.driver).toBeNull();   // no driver accepted yet
    const again = await tool("config");
    expect(again.body.customer.previousCalls.at(-1).transcriptEnd).toContain("silla de bebé");
    expect(again.body.customer.bookings[0]).toHaveProperty("status");
    expect((await waDb.customerContext!(DEMO_OPERATOR_ID, "+0000000000"))!.bookings).toEqual([]);   // other numbers see nothing
    await tool("note", { note: "Quiere saber si hay sillita para bebé", callback: true });
    expect((await q("select wants_callback, bot_note from wa_calls where provider_call_id = 'wacid.V1'"))[0]).toEqual({ wants_callback: true, bot_note: "Quiere saber si hay sillita para bebé" });
  });

  it("refuses wrong tokens and calls the bot didn't answer; disconnects LiveKit when the call ends", async () => {
    expect((await tool("config", {}, { token: "nope" })).status).toBe(401);
    const { voiceTool, voiceToken } = await import("@shared/whatsapp/voice.ts");
    const r = await voiceTool({ cfg: (await new PgStore(pool).loadConfig("soytutaxi"))!, store: new PgStore(pool), now: new Date(), secret: "voice-secret",
      statusTokenSecret: "s", publicAppUrl: "x", call: (id) => waDb.callByProvider(id), bookingsForPhone: async () => [], note: async () => {}, sendWhatsApp: async () => true },
      { callId: "wacid.V0", token: await voiceToken("voice-secret", "wacid.V0"), action: "config" });
    expect(r.status).toBe(404);   // desk-handled call
    await processWebhook(callHook([{ id: "wacid.V1", from: "5491100007777", event: "terminate", status: "COMPLETED", duration: 120 }]), vdeps());
    expect(disconnected).toEqual(["wacid.V1"]);
    expect((await q("select status, duration_s from wa_calls where provider_call_id = 'wacid.V1'"))[0]).toEqual({ status: "ended", duration_s: 120 });
    await setMode("desk");
  });
});
