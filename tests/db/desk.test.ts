// Booking desk (Central de reservas): Auto/Manual hand-off, send-to-dispatch methods, agent role, WhatsApp calls.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_DRIVERS, DEMO_OPERATOR_ID, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const DISPATCHER = DEMO_STAFF[1].userId;
const AGENT = "77777777-0000-4000-8000-000000000001";
const DU = DEMO_DRIVERS.map((_, i) => `88888888-0000-4000-8000-00000000000${i + 1}`);
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);

async function as<T = any>(sub: string | null, sql: string, params: unknown[] = []): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
const one = async (sub: string | null, sql: string, params: unknown[] = []) => (await as<any[]>(sub, sql, params))[0]?.r;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const booking = async (ref: string) => (await q("select * from bookings where reference = $1", [ref]))[0];

let seq = 0;
async function job(fromRef: string, hours: number) {
  const ref = `STT-DSK${String(++seq).padStart(3, "0")}`;
  const b = await booking(fromRef);
  const quote = (await q(`insert into quotes (operator_id, session_hash, source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, pickup_at, journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at)
    select operator_id, 'd', source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, now() + make_interval(mins => $2), journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at
    from quotes where id = $1 returning id`, [b.quote_id, Math.round(hours * 60)]))[0].id;
  await q(`insert into bookings (operator_id, reference, source, quote_id, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, agreed_pickup_at, est_duration_min, state, payment_mode, collection_state, amount_minor, currency, policy_id, locale, status_token_hash, status_token_expires_at, idempotency_key, request_hash)
    select operator_id, $2, 'phone', $3, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, now() + make_interval(mins => $4), est_duration_min, 'needs_driver', payment_mode, collection_state, amount_minor, currency, policy_id, locale, 'x', now() + interval '9 days', 'desk-' || $2, 'x'
    from bookings where id = $1`, [b.id, ref, quote, Math.round(hours * 60)]);
  return booking(ref);
}
const release = (sub: string, b: any, method: string) => one(sub, "select desk_release($1, $2, $3) as r", [b.id, b.version, method]);

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  await q(`insert into auth.users (id, email) values ($1,$2), ($3,'agent@demo.test')`, [DISPATCHER, DEMO_STAFF[1].email, AGENT]);
  await q("select app.grant_role_by_email('soytutaxi', $1, 'dispatcher')", [DEMO_STAFF[1].email]);
  await q("select app.grant_role_by_email('soytutaxi', 'agent@demo.test', 'agent')");
  for (let i = 0; i < 6; i++) {
    await q("insert into auth.users (id, email) values ($1, $2)", [DU[i], `driver${i + 1}@demo.test`]);
    await q("select app.link_driver_by_email($1, $2)", [DEMO_DRIVERS[i].id, `driver${i + 1}@demo.test`]);
    await q(`insert into driver_availability (operator_id, driver_id, kind, during) values ($1, $2, 'available', tstzrange(now() - interval '1 day', now() + interval '10 days', '[)'))`, [DEMO_OPERATOR_ID, DEMO_DRIVERS[i].id]);
  }
});
afterAll(async () => { await pool?.end(); });

describe("Booking desk", () => {
  it("auto mode (default): new bookings go straight to dispatch", async () => {
    const b = await job("STT-DEM001", 48);
    expect(b.desk_hold).toBe(false);
  });

  it("manual mode: new bookings wait at the desk, off the board and out of automatic escalation", async () => {
    expect(await one(AGENT, "select desk_set_mode('manual') as r")).toEqual({ mode: "manual" });
    const far = await job("STT-DEM001", 48);
    const urgent = await job("STT-DEM001", 4);
    expect([far.desk_hold, urgent.desk_hold]).toEqual([true, true]);
    expect((await q("select on_board from dispatch_booking_rows where id = $1", [far.id]))[0].on_board).toBe(false);
    await q("select app.escalate_board()");
    expect((await q("select count(*)::int as n from booking_offers where booking_id = $1", [urgent.id]))[0].n).toBe(0);
    expect((await booking(urgent.reference)).auto_dispatch).toBe(false);
  });

  it("send to dispatch → job board", async () => {
    const b = await job("STT-DEM001", 48);
    const r = await release(AGENT, b, "board");
    expect(r).toMatchObject({ method: "board", on_board: true });
    expect(await booking(b.reference)).toMatchObject({ desk_hold: false, desk_method: "board", desk_released_by: AGENT, board_hold: false });
    expect(await code(release(AGENT, await booking(b.reference), "board"))).toBe("already_sent");
  });

  it("send to dispatch → manual (dispatcher assigns): kept off the board", async () => {
    const b = await job("STT-DEM001", 48);
    await release(AGENT, b, "manual");
    const after = await booking(b.reference);
    expect(after).toMatchObject({ desk_hold: false, board_hold: true, desk_method: "manual" });
    expect((await q("select on_board from dispatch_booking_rows where id = $1", [b.id]))[0].on_board).toBe(false);
  });

  it("send to dispatch → automatic: offered to the nearest drivers right away", async () => {
    const b = await job("STT-DEM001", 30);
    const r = await release(DISPATCHER, b, "auto");
    expect(r.method).toBe("auto");
    const after = await booking(b.reference);
    expect(after).toMatchObject({ auto_dispatch: true, auto_rounds: 1 });
    expect((await q("select count(*)::int as n from booking_offers where booking_id = $1 and status = 'open'", [b.id]))[0].n).toBeGreaterThan(0);
  });

  it("stale versions and outsiders are refused; agents can't use dispatch commands", async () => {
    const b = await job("STT-DEM001", 48);
    expect(await code(one(AGENT, "select desk_release($1, $2, 'board') as r", [b.id, b.version - 1]))).toBe("stale_version");
    expect(await code(release(DU[0], b, "board"))).toBe("forbidden");
    expect(await code(one(null, "select desk_set_mode('auto') as r"))).toBe("forbidden");
    expect(await code(one(AGENT, "select dispatch_cancel($1, $2, 'x') as r", [b.id, b.version]))).toBe("forbidden");
    // …but agents can read the dispatch view and WhatsApp chats.
    expect((await as<any[]>(AGENT, "select count(*)::int as n from dispatch_booking_rows"))[0].n).toBeGreaterThan(5);
  });

  it("switching back to auto stops holding new bookings", async () => {
    await one(DISPATCHER, "select desk_set_mode('auto') as r");
    expect((await job("STT-DEM001", 48)).desk_hold).toBe(false);
  });
});

describe("WhatsApp calls", () => {
  const svc = (sql: string, params: unknown[] = []) => q(sql, params);

  it("an incoming call rings, opens the chat, and only one agent can answer", async () => {
    const id = (await svc("select wa_call_incoming($1, 'wacid.1', '447700900888', 'Ada Lovelace', 'v=0 offer') as r", [DEMO_OPERATOR_ID]))[0].r;
    expect(id).toBeTruthy();
    expect((await svc("select wa_call_incoming($1, 'wacid.1', '447700900888', 'Ada', 'v=0') as r", [DEMO_OPERATOR_ID]))[0].r).toBeNull();
    const [c] = await as<any[]>(AGENT, "select status, caller_name, phone_e164, offer_sdp from wa_calls where id = $1", [id]);
    expect(c).toMatchObject({ status: "ringing", caller_name: "Ada Lovelace", phone_e164: "+447700900888", offer_sdp: "v=0 offer" });
    const [conv] = await svc("select last_inbound_at is not null as open from wa_conversations where wa_id = '447700900888'");
    expect(conv.open).toBe(true);

    const [a, b] = await Promise.all([
      svc("select (wa_call_claim($1, $2)).id as r", [id, AGENT]),
      svc("select (wa_call_claim($1, $2)).id as r", [id, DISPATCHER]),
    ]);
    expect([a[0].r, b[0].r].filter(Boolean)).toHaveLength(1);
    await svc("select wa_call_set($1, 'active')", [id]);
    await svc("select wa_call_terminated('wacid.1', 'COMPLETED', 95)");
    const [done] = await svc("select status, duration_s, offer_sdp from wa_calls where id = $1", [id]);
    expect(done).toEqual({ status: "ended", duration_s: 95, offer_sdp: null });
    expect((await svc("select preview from wa_messages where provider_message_id = 'call:wacid.1'"))[0].preview).toBe("📞 Llamada · 1 min 35 s");
  });

  it("unanswered calls are missed; callers' calls are linked to the booking made during the call", async () => {
    const id = (await svc("select wa_call_incoming($1, 'wacid.2', '447700900888', null, 'v=0') as r", [DEMO_OPERATOR_ID]))[0].r;
    await svc("select wa_call_terminated('wacid.2', 'COMPLETED', null)");
    expect((await svc("select status from wa_calls where id = $1", [id]))[0].status).toBe("missed");
    expect((await svc("select preview from wa_messages where provider_message_id = 'call:wacid.2'"))[0].preview).toBe("📞 Llamada perdida");
    await one(AGENT, "select desk_call_link_booking($1, 'STT-DEM001') as r", [id]);
    expect((await svc("select b.reference from wa_calls c join bookings b on b.id = c.booking_id where c.id = $1", [id]))[0].reference).toBe("STT-DEM001");
  });

  it("call functions are closed to browsers; strangers can't see calls", async () => {
    expect(await code(as(AGENT, "select wa_call_claim(gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    expect((await as<any[]>("00000000-0000-4000-8000-0000000000aa", "select count(*)::int as n from wa_calls"))[0].n).toBe(0);
  });
});
