// Job board: advance jobs listed for drivers to claim; urgent/unclaimed jobs go nearest-first.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_DRIVERS, DEMO_OPERATOR_ID, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const DISPATCHER = DEMO_STAFF[1].userId;
const DU = DEMO_DRIVERS.map((_, i) => `88888888-0000-4000-8000-00000000000${i + 1}`);
const DID = DEMO_DRIVERS.map((d) => d.id);
const SEDAN = [0, 2, 4];            // Martín, Diego, Javier (sedans); 1,3 minivans; 5 TaxiBus

async function as<T = any>(sub: string | null, sql: string, params: unknown[] = []): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const one = async (sub: string | null, sql: string, params: unknown[] = []) => (await as<any[]>(sub, sql, params))[0]?.r;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const booking = async (ref: string) => (await q("select * from bookings where reference = $1", [ref]))[0];
const board = (i: number) => one(DU[i], "select driver_board() as r");

let seq = 0;
/** New needs_driver booking cloned from a demo booking, picked up `hours` from now. */
async function job(fromRef: string, hours: number) {
  const ref = `STT-BRD${String(++seq).padStart(3, "0")}`;
  const b = await booking(fromRef);
  const quote = (await q(`insert into quotes (operator_id, session_hash, source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, pickup_at, journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at)
    select operator_id, 'b', source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, now() + make_interval(mins => $2), journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at
    from quotes where id = $1 returning id`, [b.quote_id, Math.round(hours * 60)]))[0].id;
  await q(`insert into bookings (operator_id, reference, source, quote_id, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, agreed_pickup_at, est_duration_min, state, payment_mode, collection_state, amount_minor, currency, policy_id, locale, status_token_hash, status_token_expires_at, idempotency_key, request_hash)
    select operator_id, $2, source, $3, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, now() + make_interval(mins => $4), est_duration_min, 'needs_driver', payment_mode, collection_state, amount_minor, currency, policy_id, locale, 'x', now() + interval '9 days', 'board-' || $2, 'x'
    from bookings where id = $1`, [b.id, ref, quote, Math.round(hours * 60)]);
  return booking(ref);
}

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 20 });
  await q(`insert into auth.users (id, email) values ($1,$2)`, [DISPATCHER, DEMO_STAFF[1].email]);
  await q("select app.grant_role_by_email('soytutaxi', $1, 'dispatcher')", [DEMO_STAFF[1].email]);
  for (let i = 0; i < 6; i++) {
    await q("insert into auth.users (id, email) values ($1, $2)", [DU[i], `driver${i + 1}@demo.test`]);
    await q("select app.link_driver_by_email($1, $2)", [DID[i], `driver${i + 1}@demo.test`]);
    // Make every driver available around the clock for 10 days so tests don't depend on the time of day.
    await q(`insert into driver_availability (operator_id, driver_id, kind, during) values ($1, $2, 'available', tstzrange(now() - interval '1 day', now() + interval '10 days', '[)'))`, [DEMO_OPERATOR_ID, DID[i]]);
  }
  // Seeded demo bookings would otherwise interfere with board listings.
  await q("update bookings set board_hold = true where reference like 'STT-DEM%' and state = 'needs_driver'");
});
afterAll(async () => { await pool?.end(); });

describe("job board listing", () => {
  it("lists advance jobs (beyond 12 h) to eligible drivers only, without passenger contact or address", async () => {
    const sedanJob = await job("STT-DEM001", 40);
    const minivanJob = await job("STT-DEM002", 41);
    const urgent = await job("STT-DEM004", 5);
    const b0 = await board(0);
    const refs = (r: any) => r.jobs.map((j: any) => j.bookingId);
    expect(refs(b0)).toContain(sedanJob.id);
    expect(refs(b0)).not.toContain(minivanJob.id);        // sedan can't carry 4 pax + 4 cases
    expect(refs(b0)).not.toContain(urgent.id);            // urgent never on the board
    expect(refs(await board(1))).toEqual(expect.arrayContaining([sedanJob.id, minivanJob.id])); // minivan fits both
    const text = JSON.stringify(b0);
    expect(text).not.toContain("Honduras");
    expect(text).not.toContain("+447700900001");
    expect(b0).toMatchObject({ maxPerDay: 4, releaseUntilHours: 24, escalateHours: 12 });
    expect(b0.jobs.find((j: any) => j.bookingId === sedanJob.id)).toMatchObject({ zone: "Palermo", airport: "EZE", earningsMinor: 2400 });
  });

  it("dispatch can hold a job off the board and publish it back", async () => {
    const b = await job("STT-DEM001", 50);
    await one(DISPATCHER, "select dispatch_board($1,'hold',$2) as r", [b.id, b.version]);
    expect((await board(0)).jobs.some((j: any) => j.bookingId === b.id)).toBe(false);
    expect((await one(DU[0], "select driver_claim($1) as r", [b.id])).outcome).toBe("not_on_board");
    const held = await booking(b.reference);
    const r = await one(DISPATCHER, "select dispatch_board($1,'publish',$2) as r", [b.id, held.version]);
    expect(r.on_board).toBe(true);
    expect(await code(as(DU[0], "select dispatch_board($1,'hold',1)", [b.id]))).toBe("forbidden");
  });
});

describe("claiming", () => {
  it("simultaneous claims by three drivers → exactly one wins, job leaves the board", async () => {
    const b = await job("STT-DEM001", 44);
    const outcomes = await Promise.all(SEDAN.map((i) => one(DU[i], "select driver_claim($1) as r", [b.id]).then((r) => r.outcome, (e) => e.message)));
    expect(outcomes.filter((o) => o === "claimed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already_taken")).toHaveLength(2);
    const act = await q("select claim_source from assignments where booking_id = $1 and state <> 'released'", [b.id]);
    expect(act).toEqual([{ claim_source: "board" }]);
    expect((await booking(b.reference)).state).toBe("confirmed");
    for (const i of SEDAN) expect((await board(i)).jobs.some((j: any) => j.bookingId === b.id)).toBe(false);
  });

  it("enforces the per-day claim cap and hides overlapping jobs", async () => {
    await q(`update policies set config = config || '{"board_max_claims_per_day": 1}' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    try {
      const a = await job("STT-DEM001", 60);
      const c = await job("STT-DEM001", 64);        // same local day (or next) — check cap by day
      const overlap = await job("STT-DEM001", 60.5); // overlaps a
      expect((await one(DU[2], "select driver_claim($1) as r", [a.id])).outcome).toBe("claimed");
      expect((await board(2)).jobs.some((j: any) => j.bookingId === overlap.id)).toBe(false);
      const sameDay = (await q(`select ((select agreed_pickup_at from bookings where id=$1) at time zone 'America/Argentina/Buenos_Aires')::date = ((select agreed_pickup_at from bookings where id=$2) at time zone 'America/Argentina/Buenos_Aires')::date as same`, [a.id, c.id]))[0].same;
      const r = await code(one(DU[2], "select driver_claim($1) as r", [c.id]));
      expect(r).toBe(sameDay ? "claim_limit_reached" : "ok");
    } finally {
      await q(`update policies set config = config - 'board_max_claims_per_day' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    }
  });

  it("a driver can give a job back until 24 h before pickup; it returns to the board", async () => {
    const b = await job("STT-DEM001", 48);
    await one(DU[4], "select driver_claim($1) as r", [b.id]);
    const jobs = await one(DU[4], "select driver_jobs() as r");
    const mine = jobs.find((j: any) => j.reference === b.reference);
    expect(mine).toMatchObject({ claimSource: "board", canDrop: true });
    const r = await one(DU[4], "select driver_release_claim($1, 'Problema familiar') as r", [mine.assignmentId]);
    expect(r).toEqual({ outcome: "released", on_board: true });
    expect((await board(0)).jobs.some((j: any) => j.bookingId === b.id)).toBe(true);
    const ex = await q("select kind, severity from exceptions where booking_id = $1", [b.id]);
    expect(ex).toEqual([{ kind: "lost_cover", severity: "warning" }]);
  });

  it("inside 24 h the driver must ask dispatch", async () => {
    const b = await job("STT-DEM001", 20);
    await q("update bookings set board_hold = true where id = $1", [b.id]); // off board; assign directly
    await one(DISPATCHER, "select dispatch_assign($1,$2,$3) as r", [b.id, DID[4], b.version]);
    const mine = (await one(DU[4], "select driver_jobs() as r")).find((j: any) => j.reference === b.reference);
    expect(mine.canDrop).toBe(false);
    expect(await code(as(DU[4], "select driver_release_claim($1)", [mine.assignmentId]))).toBe("release_window_closed");
  });
});

describe("automatic nearest-first escalation", () => {
  it("urgent and newly-due jobs are offered to the nearest drivers, in rounds, skipping drivers who declined", async () => {
    await q("update bookings set board_hold = true where state = 'needs_driver' and reference like 'STT-BRD%'");
    const b = await job("STT-DEM001", 6);           // urgent: inside 12 h
    // Driver positions: Javier closest to EZE, then Diego, then Martín.
    for (const [i, lat, lng] of [[4, -34.80, -58.53], [2, -34.70, -58.50], [0, -34.60, -58.40]] as const) {
      await as(DU[i], "select driver_set_shift(true)");
      await as(DU[i], "select driver_report_location($1,$2)", [lat, lng]);
    }
    await q(`update policies set config = config || '{"auto_offer_group_size": 1}' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    try {
      expect((await q("select app.escalate_board() as n"))[0].n).toBe(1);
      const first = await q("select driver_id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
      expect(first).toEqual([{ driver_id: DID[4] }]);                       // nearest first
      const after = await booking(b.reference);
      expect([after.auto_dispatch, after.auto_rounds, after.board_closed_at !== null]).toEqual([true, 1, true]);
      expect((await q("select kind from exceptions where booking_id = $1", [b.id])).map((r) => r.kind)).toEqual(["auto_dispatch_started"]);

      // Running again while an offer is open does nothing.
      expect((await q("select app.escalate_board() as n"))[0].n).toBe(0);

      // Javier declines → next round goes to the next nearest (Diego), not back to Javier.
      const [o] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
      await one(DU[4], "select driver_respond_offer($1, false) as r", [o.id]);
      await q("select app.escalate_board()");
      expect(await q("select driver_id from booking_offers where booking_id = $1 and status = 'open'", [b.id])).toEqual([{ driver_id: DID[2] }]);

      // Diego lets it expire → Martín.
      await q("update booking_offers set expires_at = now() - interval '1 second' where booking_id = $1 and status = 'open'", [b.id]);
      await q("select app.escalate_board()");
      expect(await q("select driver_id from booking_offers where booking_id = $1 and status = 'open'", [b.id])).toEqual([{ driver_id: DID[0] }]);

      // Martín accepts → auto-dispatch ends.
      const [o3] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
      expect((await one(DU[0], "select driver_respond_offer($1, true) as r", [o3.id])).outcome).toBe("accepted");
      expect((await booking(b.reference)).auto_dispatch).toBe(false);
    } finally {
      await q(`update policies set config = config || '{"auto_offer_group_size": 3}' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    }
  });

  it("alerts dispatch when nobody eligible is left, and when rounds run out", async () => {
    await q("update bookings set board_hold = true where state = 'needs_driver' and reference like 'STT-BRD%'");
    const bus = await job("STT-DEM005", 7);          // 10 pax: only the TaxiBus fits
    await q("update drivers set approval_status = 'suspended' where id = $1", [DID[5]]);
    try {
      await q("select app.escalate_board()");
      expect((await q("select kind, severity from exceptions where booking_id = $1 order by kind", [bus.id])))
        .toEqual([{ kind: "auto_dispatch_started", severity: "warning" }, { kind: "no_driver_available", severity: "critical" }]);
      await q("select app.escalate_board()");      // no duplicate alerts
      expect((await q("select count(*)::int n from exceptions where booking_id = $1", [bus.id]))[0].n).toBe(2);
    } finally {
      await q("update drivers set approval_status = 'approved' where id = $1", [DID[5]]);
    }
    await q("update bookings set auto_rounds = 5 where id = $1", [bus.id]);
    await q("select app.escalate_board()");
    expect((await q("select severity from exceptions where booking_id = $1 and kind = 'auto_dispatch_exhausted'", [bus.id]))).toEqual([{ severity: "critical" }]);
  });

  it("unclaimed board jobs switch to nearest-first once inside 12 h", async () => {
    const b = await job("STT-DEM001", 30);
    expect((await board(0)).jobs.some((j: any) => j.bookingId === b.id)).toBe(true);
    await q("update bookings set agreed_pickup_at = now() + interval '11 hours' where id = $1", [b.id]); // time passes
    expect((await board(0)).jobs.some((j: any) => j.bookingId === b.id)).toBe(false);
    await q("select app.escalate_board()");
    const after = await booking(b.reference);
    expect(after.auto_dispatch).toBe(true);
    expect((await q("select count(*)::int n from booking_offers where booking_id = $1 and status = 'open'", [b.id]))[0].n).toBeGreaterThan(0);
  });

  it("dispatch can push a board job straight to nearest-first", async () => {
    const b = await job("STT-DEM001", 70);
    const r = await one(DISPATCHER, "select dispatch_board($1,'auto',$2) as r", [b.id, b.version]);
    expect(r).toMatchObject({ on_board: false, auto_dispatch: true });
    const row = (await as(DISPATCHER, "select on_board, auto_dispatch, open_offers from dispatch_booking_rows where id = $1", [b.id]))[0];
    expect(row.on_board).toBe(false);
    expect(row.open_offers).toBeGreaterThan(0);
  });
});
