// Phase 4: flight-based pickup changes (dispatcher-approved) and Mercado Pago payments, against PostgreSQL.
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_DRIVERS, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import { trackFlights, type FlightCacheDb } from "@shared/flights/service.ts";
import type { FlightInfo, FlightProvider } from "@shared/flights/aerodatabox.ts";
import { verifyMpSignature, type MercadoPago } from "@shared/payments/mercadopago.ts";
import { checkout, notification, processPaymentJobs, type PayDb } from "@shared/payments/service.ts";
import { ApiError } from "@shared/api/store.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const [ADMIN, DISPATCHER] = [DEMO_STAFF[0].userId, DEMO_STAFF[1].userId];
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
async function as<T = any>(sub: string, sql: string, params: unknown[] = []): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    const r = await c.query(sql, params); await c.query("commit"); return r.rows[0]?.r as T;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const booking = async (ref: string) => (await q("select * from bookings where reference = $1", [ref]))[0];
const minutes = (a: Date | string, b: Date | string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000);
async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const keys = Object.keys(args);
  try {
    const rows = await q(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
    return rows[0].r as T;
  } catch (e: any) {
    if (/^[a-z_]+$/.test(e.message)) throw new ApiError(Number(e.detail) || 400, e.message, e.message);
    throw e;
  }
}

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  for (const s of DEMO_STAFF) {
    await q("insert into auth.users (id, email) values ($1, $2)", [s.userId, s.email]);
    await q("select app.grant_role_by_email('soytutaxi', $1, $2)", [s.email, s.role]);
  }
});
afterAll(async () => { await pool?.end(); });

describe("Flight tracking → proposed pickup → dispatcher decision", () => {
  const apply = (id: string, status: string, arrival: Date | null, kind = "gate", airport: string | null = null, ambiguous = false) =>
    rpc("flight_tracking_apply", { p_booking: id, p_status: status, p_arrival: arrival, p_kind: kind, p_arrival_airport: airport, p_ambiguous: ambiguous });

  it("watches arrivals inside the window and proposes a new pickup beyond the threshold", async () => {
    // DEM002: AEP arrival (30 min buffer), confirmed with a driver. Put it 6 h ahead.
    await q("update bookings set agreed_pickup_at = date_trunc('minute', now()) + interval '6 hours' where reference = 'STT-DEM002'");
    await q("update assignments s set occupied = tstzrange(b.agreed_pickup_at, b.agreed_pickup_at + interval '90 minutes', '[)') from bookings b where b.id = s.booking_id and b.reference = 'STT-DEM002' and s.state <> 'released'");
    const b = await booking("STT-DEM002");
    const targets = await q("select * from flight_tracking_targets()");
    expect(targets.map((t) => t.booking_id)).toContain(b.id);

    const landing = new Date(new Date(b.agreed_pickup_at).getTime() - 30 * 60_000);
    expect((await apply(b.id, "en_route", new Date(landing.getTime() + 5 * 60_000))).outcome).toBe("unchanged");   // +5 min: under threshold
    const r = await apply(b.id, "delayed", new Date(landing.getTime() + 50 * 60_000));
    expect(r.outcome).toBe("proposed");
    const after = await booking("STT-DEM002");
    expect(minutes(after.proposed_pickup_at, after.agreed_pickup_at)).toBe(50);
    expect(after.version).toBe(b.version);                       // tracking never bumps the version
    expect((await q("select severity from exceptions where booking_id = $1 and kind = 'pickup_change_proposed' and state <> 'resolved'", [b.id]))[0].severity).toBe("warning");
    // Back to normal → the proposal is withdrawn.
    expect((await apply(b.id, "en_route", landing)).outcome).toBe("withdrawn");
    expect((await booking("STT-DEM002")).proposed_pickup_at).toBeNull();
  });

  it("runway time alone is labelled and gets the taxi-to-gate allowance", async () => {
    const b = await booking("STT-DEM002");
    const runway = new Date(new Date(b.agreed_pickup_at).getTime() + 10 * 60_000);
    await apply(b.id, "landed", runway, "runway_plus_taxi");
    const after = await booking("STT-DEM002");
    expect(after.flight_estimate_kind).toBe("runway_plus_taxi");
    expect(minutes(after.flight_estimated_arrival_at, runway)).toBe(10);
    expect(minutes(after.proposed_pickup_at, runway)).toBe(40);    // +10 taxi +30 AEP buffer
  });

  it("approval moves pickup and the driver's slot together, supersedes offers and notifies passenger and driver", async () => {
    const b = await booking("STT-DEM002");
    const r = await as(DISPATCHER, "select dispatch_pickup_decide($1, $2, true) as r", [b.id, b.version]);
    expect(r.outcome).toBe("approved");
    const after = await booking("STT-DEM002");
    expect(new Date(after.agreed_pickup_at).getTime()).toBe(new Date(b.proposed_pickup_at).getTime());
    expect(after.proposed_pickup_at).toBeNull();
    const [s] = await q("select lower(occupied) as start from assignments where booking_id = $1 and state <> 'released'", [b.id]);
    expect(new Date(s.start).getTime()).toBe(new Date(after.agreed_pickup_at).getTime());
    const kinds = (await q("select kind from outbox_jobs where payload->>'booking_id' = $1 and kind like 'notify.%pickup_changed'", [b.id])).map((x) => x.kind).sort();
    expect(kinds).toEqual(["notify.driver.pickup_changed", "notify.passenger.pickup_changed"]);
    expect(await code(as(DISPATCHER, "select dispatch_pickup_decide($1, $2, true) as r", [b.id, after.version]))).toBe("no_proposal");
  });

  it("a clash with the driver's next trip is refused unless dispatch releases the driver", async () => {
    const b = await booking("STT-DEM002");
    const [s] = await q("select * from assignments where booking_id = $1 and state <> 'released'", [b.id]);
    // Another job for the same driver/vehicle 2 h after the current pickup.
    const other = await booking("STT-DEM006");
    await q("update bookings set agreed_pickup_at = $2::timestamptz + interval '2 hours', state = 'confirmed' where id = $1", [other.id, b.agreed_pickup_at]);
    await q(`insert into assignments (operator_id, booking_id, driver_id, vehicle_id, state, occupied)
             values ($1, $2, $3, $4, 'confirmed', tstzrange($5::timestamptz + interval '2 hours', $5::timestamptz + interval '4 hours', '[)'))`,
      [b.operator_id, other.id, s.driver_id, s.vehicle_id, b.agreed_pickup_at]);
    await apply(b.id, "delayed", new Date(new Date(b.agreed_pickup_at).getTime() + 90 * 60_000));
    const p = await booking("STT-DEM002");
    expect(await code(as(DISPATCHER, "select dispatch_pickup_decide($1, $2, true) as r", [p.id, p.version]))).toBe("driver_conflict");
    expect((await booking("STT-DEM002")).proposed_pickup_at).not.toBeNull();       // nothing changed
    const r = await as(DISPATCHER, "select dispatch_pickup_decide($1, $2, true, true) as r", [p.id, p.version]);
    expect(r).toMatchObject({ outcome: "approved", releasedDriver: true });
    expect((await booking("STT-DEM002")).state).toBe("needs_driver");
  });

  it("dismissed proposals aren't raised again for the same time; cancellations and other airports go to review", async () => {
    const b = await booking("STT-DEM006");
    await q("update bookings set state = 'needs_driver', agreed_pickup_at = date_trunc('minute', now()) + interval '8 hours' where id = $1", [b.id]);
    const fresh = await booking("STT-DEM006");
    const late = new Date(new Date(fresh.agreed_pickup_at).getTime() - 60 * 60_000 + 40 * 60_000);   // EZE buffer 60
    expect((await apply(fresh.id, "delayed", late)).outcome).toBe("proposed");
    const p = await booking("STT-DEM006");
    expect((await as(DISPATCHER, "select dispatch_pickup_decide($1, $2, false) as r", [p.id, p.version])).outcome).toBe("dismissed");
    expect((await apply(fresh.id, "delayed", new Date(late.getTime() + 3 * 60_000))).outcome).toBe("dismissed_before");
    expect((await apply(fresh.id, "cancelled", late)).outcome).toBe("review");
    expect((await apply(fresh.id, "en_route", late, "gate", "AEP")).reason).toBe("different_airport");
    expect((await q("select count(*)::int as n from exceptions where booking_id = $1 and kind = 'flight_review' and severity = 'critical'", [fresh.id]))[0].n).toBe(1);
    expect(await code(as(DEMO_STAFF[2].userId, "select dispatch_pickup_decide($1, 1, true) as r", [fresh.id]))).toBe("forbidden");
  });

  it("tracking pass: one provider call per flight, readings applied, provider failure keeps the agreed time", async () => {
    await q("update bookings set flight_checked_at = null, flight_review_reason = null where reference in ('STT-DEM001','STT-DEM004')");
    await q("update bookings set agreed_pickup_at = date_trunc('minute', now()) + interval '5 hours', state = 'needs_driver' where reference in ('STT-DEM001','STT-DEM004')");
    const calls: string[] = [];
    const leg = (number: string, sched: Date, est: Date | null): FlightInfo => ({ number, airline: "X", other: { iata: "MAD", city: "Madrid" }, scheduled: sched.toISOString(),
      estimated: est?.toISOString() ?? null, actual: null, status: est ? "delayed" : "scheduled", terminal: "A", gate: null, belt: null, airport: "EZE", date: "x" });
    const dem1 = await booking("STT-DEM001");
    const provider: FlightProvider = {
      async board() { return []; },
      async flight(n) {
        calls.push(n);
        if (n === "AA997") throw new Error("down");
        const sched = new Date(new Date(dem1.agreed_pickup_at).getTime() - 60 * 60_000);
        return [leg(n, sched, new Date(sched.getTime() + 45 * 60_000))];
      },
    };
    const store = new Map<string, any>();
    const cache: FlightCacheDb = { async get(k) { return store.get(k) ?? null; }, async put(k, payload, expiresAt) { store.set(k, { payload, fetchedAt: new Date().toISOString(), expiresAt }); } };
    const targets = await q("select * from flight_tracking_targets()");
    const r = await trackFlights(cache, provider, targets.map((t) => ({ ...t, local_date: t.local_date.toISOString?.().slice(0, 10) ?? t.local_date })),
      async (id, status, arrival, kind, airport, amb) => rpc("flight_tracking_apply", { p_booking: id, p_status: status, p_arrival: arrival, p_kind: kind, p_arrival_airport: airport, p_ambiguous: amb }), new Date());
    expect(calls.filter((c) => c === "AR1303")).toHaveLength(1);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(minutes((await booking("STT-DEM001")).proposed_pickup_at, dem1.agreed_pickup_at)).toBe(45);
    const dem4 = await booking("STT-DEM004");
    expect(dem4.proposed_pickup_at).toBeNull();
    expect(dem4.flight_checked_at).toBeNull();                   // stale: shown as not checked, pickup unchanged
  });
});

describe("Mercado Pago payments", () => {
  const TOKEN = "status-token-for-tests-0123456789";
  const hash = createHash("sha256").update(TOKEN).digest("hex");
  let prefs = 0;
  const refunds: string[] = [];
  const payments = new Map<string, { status: string; amountMinor: number; currency: string; externalReference: string }>();
  const mp: MercadoPago = {
    async createPreference(a) { prefs++; return { id: `pref-${prefs}`, url: `https://mp.test/checkout/${a.attemptId}` }; },
    async getPayment(id) { const p = payments.get(id); return p ? { id, ...p, approvedAt: new Date().toISOString(), collectorId: "777" } : null; },
    async refund(pid, amount, idem) { refunds.push(`${pid}:${amount}:${idem}`); return { id: `rf-${refunds.length}`, status: "approved" }; },
  };
  const payDb: PayDb = {
    checkoutContext: (ref, h) => rpc("pay_checkout_context", { p_reference: ref, p_token_hash: h }),
    createAttempt: (b, amount, cur, fare, fareCur, fx, exp) => rpc("pay_attempt_create", { p_booking: b, p_amount: amount, p_currency: cur, p_fare_amount: fare, p_fare_currency: fareCur, p_fx: fx, p_expires: exp }),
    attemptReady: async (id, pref, url, ok) => { await rpc("pay_attempt_ready", { p_attempt: id, p_preference: pref, p_url: url, p_ok: ok }); },
    record: (a, p, s, amt, cur, at) => rpc("pay_record", { p_attempt: a, p_provider_payment_id: p, p_status: s, p_amount: amt, p_currency: cur, p_approved_at: at }),
    inboxClaim: async (key) => (await q("insert into inbox_events (operator_id, provider, event_key) select id, 'mercadopago', $1 from operators limit 1 on conflict do nothing returning id", [key])).length === 1,
    inboxDone: async (key) => { await q("update inbox_events set processed_at = now() where provider = 'mercadopago' and event_key = $1", [key]); },
    outboxClaim: async (limit) => q("select * from pay_outbox_claim($1)", [limit]),
    outboxFinish: async (job, ok, error, final) => { await rpc("wa_outbox_finish", { p_job: job, p_ok: ok, p_error: error, p_final: final }); },
    refundContext: (id) => rpc("pay_refund_context", { p_refund: id }),
    refundSet: async (id, state, pid, error) => { await rpc("pay_refund_set", { p_refund: id, p_state: state, p_provider_refund_id: pid, p_error: error }); },
  };
  const deps = { db: payDb, mp, publicAppUrl: "https://example.test", notificationUrl: "https://x/functions/v1/payments/webhook", collectorId: "777" };
  const pay = async (id: string, attempt: string, amount: number, status = "approved", currency = "ARS") => {
    payments.set(id, { status, amountMinor: amount, currency, externalReference: attempt });
    return notification(deps, { type: "payment", dataId: id, requestId: `req-${id}-${status}` });
  };

  beforeAll(async () => {
    await q("update policies set config = config || '{\"payments_enabled\": true}'::jsonb");
    await q("update bookings set status_token_hash = $1, status_token_expires_at = now() + interval '9 days' where reference in ('STT-DEM003','STT-DEM007','STT-DEM008')", [hash]);
  });

  it("only admins/finance set the charge currency and exchange rate; checkout needs it for USD fares", async () => {
    expect(await code(checkout(deps, "STT-DEM003", TOKEN))).toBe("fx_rate_missing");
    expect(await code(as(DISPATCHER, "select admin_set_payment_settings('ARS', '{\"USD\": 1000}') as r"))).toBe("forbidden");
    expect(await code(as(ADMIN, "select admin_set_payment_settings('ARS', '{\"USD\": -1}') as r"))).toBe("invalid_settings");
    await as(ADMIN, "select admin_set_payment_settings('ARS', '{\"USD\": 1000}') as r");
  });

  it("checkout locks the converted amount and reuses the live link; wrong tokens see nothing", async () => {
    const r1 = await checkout(deps, "STT-DEM003", TOKEN);
    const r2 = await checkout(deps, "stt-dem003", TOKEN);
    expect(r1.url).toBe(r2.url);
    expect(prefs).toBe(1);
    const [a] = await q("select a.* from payment_attempts a join bookings b on b.id = a.booking_id where b.reference = 'STT-DEM003'");
    const b = await booking("STT-DEM003");
    expect(a).toMatchObject({ currency: "ARS", fare_currency: "USD", amount_minor: String(Number(b.amount_minor) * 1000) });
    expect(await code(checkout(deps, "STT-DEM003", "wrong-token-xxxxxxxxxxxxxxxx"))).toBe("booking_not_found");
    expect(await code(checkout(deps, "STT-DEM008", TOKEN))).toBe("not_payable");          // cancelled
  });

  it("a verified approved payment confirms the held driver once; duplicates, extras and mismatches go to review", async () => {
    const [a] = await q("select a.* from payment_attempts a join bookings b on b.id = a.booking_id where b.reference = 'STT-DEM003'");
    expect(await pay("1001", a.id, Number(a.amount_minor) - 100)).toBe("mismatch");
    expect((await booking("STT-DEM003")).state).toBe("held");
    expect(await pay("1002", a.id, Number(a.amount_minor), "pending")).toBe("pending");
    expect(await pay("1002", a.id, Number(a.amount_minor))).toBe("confirmed");
    const b = await booking("STT-DEM003");
    expect(b).toMatchObject({ state: "confirmed", collection_state: "collected" });
    expect((await q("select state from assignments where booking_id = $1 and state <> 'released'", [b.id]))[0].state).toBe("confirmed");
    expect(await notification(deps, { type: "payment", dataId: "1002", requestId: "req-1002-approved" })).toBe("duplicate");
    expect(await notification(deps, { type: "payment", dataId: "1002", requestId: "retry-2" })).toBe("already_recorded");
    // A late "pending" for the same payment never downgrades it.
    payments.set("1002", { ...payments.get("1002")!, status: "pending" });
    await notification(deps, { type: "payment", dataId: "1002", requestId: "late-pending" });
    expect((await q("select status from payments where provider_payment_id = '1002'"))[0].status).toBe("approved");
    expect(await pay("1003", a.id, Number(a.amount_minor))).toBe("extra_payment");
    expect((await q("select count(*)::int as n from outbox_jobs where kind = 'notify.passenger.confirmed' and payload->>'booking_id' = $1", [b.id]))[0].n).toBe(1);
    const kinds = (await q("select kind from exceptions where booking_id = $1 and state <> 'resolved' order by kind", [b.id])).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["payment_extra", "payment_mismatch"]));
    // Payments for another merchant or without our reference are ignored.
    payments.set("1004", { status: "approved", amountMinor: 1, currency: "ARS", externalReference: "not-ours" });
    expect(await notification(deps, { type: "payment", dataId: "1004", requestId: "r" })).toBe("foreign_payment");
  });

  it("late payments (hold expired) and payments on cancelled bookings are kept and flagged, never confirmed", async () => {
    // DEM007: give it a held assignment that has already expired.
    const b = await booking("STT-DEM007");
    await q("update assignments set state = 'reserving', hold_expires_at = now() - interval '1 minute' where booking_id = $1 and state <> 'released'", [b.id]);
    await q("update bookings set state = 'held' where id = $1", [b.id]);
    const aid = await rpc("pay_attempt_create", { p_booking: b.id, p_amount: 5000, p_currency: "ARS", p_fare_amount: 5, p_fare_currency: "USD", p_fx: 1000, p_expires: new Date(Date.now() + 60_000) });
    await q("select app.expire_stale()");
    expect(await pay("2001", aid, 5000)).toBe("paid_without_cover");
    expect((await booking("STT-DEM007")).state).toBe("needs_driver");
    const c = await booking("STT-DEM008");
    const cid = await rpc("pay_attempt_create", { p_booking: c.id, p_amount: 4000, p_currency: "ARS", p_fare_amount: 4, p_fare_currency: "USD", p_fx: 1000, p_expires: new Date(Date.now() + 60_000) });
    expect(await pay("2002", cid, 4000)).toBe("paid_cancelled");
    expect((await booking("STT-DEM008")).state).toBe("cancelled");
  });

  it("refunds: stored first, sent once with an idempotency key, completed, passenger notified; over-refund refused", async () => {
    const c = await booking("STT-DEM008");
    expect(await code(as(DISPATCHER, "select dispatch_refund($1, 4001, 'x') as r", [c.id]))).toBe("invalid_amount");
    expect(await code(as(DISPATCHER, "select dispatch_refund($1, 100, '') as r", [c.id]))).toBe("reason_required");
    const r = await as(DISPATCHER, "select dispatch_refund($1, 4000, 'Pagó una reserva cancelada') as r", [c.id]);
    expect(await processPaymentJobs(deps)).toEqual({ done: 1, failed: 0 });
    expect(refunds).toEqual([`2002:4000:refund-${r.refundId}`]);
    expect((await q("select state from refunds where id = $1", [r.refundId]))[0].state).toBe("completed");
    expect((await q("select reconciliation from payments where provider_payment_id = '2002'"))[0].reconciliation).toBe("resolved");
    expect((await q("select count(*)::int as n from outbox_jobs where kind = 'notify.passenger.refund' and payload->>'booking_id' = $1", [c.id]))[0].n).toBe(1);
    expect(await code(as(DISPATCHER, "select dispatch_refund($1, 1, 'again') as r", [c.id]))).toBe("invalid_amount");
    const [row] = await q("select paid_minor, refunded_minor, payment_review from dispatch_booking_rows where id = $1", [c.id]);
    expect(row).toEqual({ paid_minor: "4000", refunded_minor: "4000", payment_review: false });
  });

  it("a prepaid booking reserved by a driver asks the passenger to pay", async () => {
    const b = await booking("STT-DEM001");
    await q("update bookings set state = 'held', version = version + 1 where id = $1", [b.id]);
    expect((await q("select count(*)::int as n from outbox_jobs where kind = 'notify.passenger.payment_due' and payload->>'booking_id' = $1", [b.id]))[0].n).toBe(1);
    void DEMO_DRIVERS;
  });
});

describe("Mercado Pago signature", () => {
  const secret = "mp-secret";
  const sign = (manifest: string) => createHmac("sha256", secret).update(manifest).digest("hex");
  it("accepts the documented manifest and rejects tampering, old timestamps and missing parts", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const good = `ts=${ts},v1=${sign(`id:123456;request-id:req-1;ts:${ts};`)}`;
    expect(await verifyMpSignature(good, "req-1", "123456", secret)).toBe(true);
    expect(await verifyMpSignature(good, "req-2", "123456", secret)).toBe(false);
    expect(await verifyMpSignature(good, "req-1", "123457", secret)).toBe(false);
    expect(await verifyMpSignature(good, "req-1", "123456", "other")).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(await verifyMpSignature(`ts=${old},v1=${sign(`id:123456;request-id:req-1;ts:${old};`)}`, "req-1", "123456", secret)).toBe(false);
    // Missing request id → that pair is left out of the manifest.
    expect(await verifyMpSignature(`ts=${ts},v1=${sign(`id:123456;ts:${ts};`)}`, null, "123456", secret)).toBe(true);
    expect(await verifyMpSignature(null, "req-1", "123456", secret)).toBe(false);
    // Alphanumeric ids are lowercased.
    expect(await verifyMpSignature(`ts=${ts},v1=${sign(`id:ord01abc;request-id:r;ts:${ts};`)}`, "r", "ORD01ABC", secret)).toBe(true);
  });
});
