// Phase 2 integration tests: offers, allocation races, overlaps, trip progress, earnings, locations.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_DRIVERS, DEMO_OPERATOR_ID, DEMO_STAFF, DEMO_VEHICLES } from "@shared/domain/fixtures.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const DISPATCHER = DEMO_STAFF[1].userId, FINANCE = DEMO_STAFF[2].userId;
// Auth user ids for the six approved demo drivers (index-aligned with DEMO_DRIVERS).
const DU = DEMO_DRIVERS.map((_, i) => `88888888-0000-4000-8000-00000000000${i + 1}`);
const DID = DEMO_DRIVERS.map((d) => d.id);

/** Run one statement as a Supabase role/JWT subject in its own committed transaction. */
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
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const booking = async (ref: string) => (await q("select * from bookings where reference = $1", [ref]))[0];

/** Clone a demo booking under a new reference at a different local pickup time (for overlap tests). */
async function cloneBooking(ref: string, newRef: string, shiftMinutes: number) {
  const b = await booking(ref);
  const quote = (await q(`insert into quotes (operator_id, session_hash, source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, pickup_at, journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at)
    select operator_id, 'clone', source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags, carry_on, pickup_at + make_interval(mins => $2), journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, expires_at
    from quotes where id = $1 returning id`, [b.quote_id, shiftMinutes]))[0].id;
  await q(`insert into bookings (operator_id, reference, source, quote_id, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, agreed_pickup_at, est_duration_min, state, payment_mode, collection_state, amount_minor, currency, policy_id, locale, status_token_hash, status_token_expires_at, idempotency_key, request_hash)
    select operator_id, $2, source, $3, passenger_id, direction, airport_id, zone_id, pickup_place, dropoff_place, passengers, large_bags, carry_on, vehicle_class, flight_designator, flight_local_arrival_date, agreed_pickup_at + make_interval(mins => $4), est_duration_min, 'needs_driver', payment_mode, collection_state, amount_minor, currency, policy_id, locale, 'x', now() + interval '1 day', 'clone-' || $2, 'x'
    from bookings where id = $1`, [b.id, newRef, quote, shiftMinutes]);
  return booking(newRef);
}

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 20 });
  await q(`insert into auth.users (id, email) values ($1,$2),($3,$4)`, [DISPATCHER, DEMO_STAFF[1].email, FINANCE, DEMO_STAFF[2].email]);
  await q("select app.grant_role_by_email('soytutaxi', $1, 'dispatcher')", [DEMO_STAFF[1].email]);
  await q("select app.grant_role_by_email('soytutaxi', $1, 'finance')", [DEMO_STAFF[2].email]);
  for (let i = 0; i < 6; i++) {
    await q("insert into auth.users (id, email) values ($1, $2)", [DU[i], `driver${i + 1}@demo.test`]);
    await q("select app.link_driver_by_email($1, $2)", [DID[i], `driver${i + 1}@demo.test`]);
  }
});
afterAll(async () => { await pool?.end(); });

describe("roles", () => {
  it("drivers and finance cannot run dispatch commands; staff cannot run driver commands", async () => {
    const b = await booking("STT-DEM001");
    expect(await code(as(DU[0], "select dispatch_assign($1,$2,$3)", [b.id, DID[0], b.version]))).toBe("forbidden");
    expect(await code(as(FINANCE, "select dispatch_assign($1,$2,$3)", [b.id, DID[0], b.version]))).toBe("forbidden");
    expect(await code(as(DISPATCHER, "select driver_set_shift(true)"))).toBe("not_a_driver");
    expect(await code(as(null, "select driver_jobs()"))).toBe("not_a_driver");
  });
});

describe("offers and allocation races", () => {
  it("acceptance: simultaneous driver acceptances + a manual assignment → one active assignment, one winner, one confirmation", async () => {
    let b = await booking("STT-DEM001");
    const off = await one(DISPATCHER, "select dispatch_offer($1,$2,null,3) as r", [b.id, b.version]);
    expect(off.offered).toBe(3);
    const offers = await q("select id, driver_id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
    expect(offers).toHaveLength(3);
    b = await booking("STT-DEM001");
    const driverIdx = offers.map((o) => DID.indexOf(o.driver_id));
    const manualDriver = [2, 4].find((i) => !driverIdx.includes(i)) ?? 4; // a sedan driver not in the offer group

    const results = await Promise.all([
      ...offers.map((o, k) => code(one(DU[driverIdx[k]], "select driver_respond_offer($1, true) as r", [o.id]).then((r) => { if (r.outcome !== "accepted") throw new Error(r.outcome); }))),
      code(as(DISPATCHER, "select dispatch_assign($1,$2,$3)", [b.id, DID[manualDriver], b.version])),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok").every((r) => ["already_taken", "stale_version", "already_assigned", "expired"].includes(r))).toBe(true);

    const active = await q("select * from assignments where booking_id = $1 and state <> 'released'", [b.id]);
    expect(active).toHaveLength(1);
    expect((await booking("STT-DEM001")).state).toBe("confirmed");           // payments not live → confirm directly
    const conf = await q("select count(*)::int n from outbox_jobs where kind = 'notify.passenger.confirmed' and payload->>'booking_id' = $1", [b.id]);
    expect(conf[0].n).toBe(1);
    const open = await q("select count(*)::int n from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
    expect(open[0].n).toBe(0);                                               // remaining offers superseded
  });

  it("acceptance: same driver accepting overlapping trips → second fails, that job stays available", async () => {
    const a = await booking("STT-DEM004");
    const clone = await cloneBooking("STT-DEM004", "STT-OVRLP1", 30); // 30 min later: overlaps 55+20 min occupancy
    const d = 2; // Diego (sedan)
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [a.id, a.version, [DID[d]]]);
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [clone.id, clone.version, [DID[d]]]);
    const [oa] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [a.id]);
    const [ob] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [clone.id]);
    expect((await one(DU[d], "select driver_respond_offer($1, true) as r", [oa.id])).outcome).toBe("accepted");
    expect(await code(as(DU[d], "select driver_respond_offer($1, true)", [ob.id]))).toBe("schedule_conflict");
    expect((await booking("STT-OVRLP1")).state).toBe("needs_driver");
    // Re-offering the clone now skips Diego (already busy) — he is not offered an overlapping trip.
    const c2 = await booking("STT-OVRLP1");
    expect(await code(as(DISPATCHER, "select dispatch_offer($1,$2,$3)", [c2.id, c2.version, [DID[d]]]))).toBe("no_eligible_drivers");
  });

  it("staff assignment rejects stale versions, too-small vehicles and out-of-hours drivers", async () => {
    const b = await booking("STT-OVRLP1");
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3)", [b.id, DID[4], b.version - 1]))).toBe("stale_version");
    const bus = await cloneBooking("STT-DEM005", "STT-BIGGRP", 600);
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3)", [bus.id, DID[4], bus.version]))).toBe("vehicle_too_small");
    const night = await cloneBooking("STT-OVRLP1", "STT-NIGHT1", -60 * 13); // ~01:50 local: outside 05–23 shifts
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3)", [night.id, DID[4], night.version]))).toBe("outside_working_hours");
  });

  it("expired and superseded offers cannot be accepted", async () => {
    let b = await booking("STT-DEM006");
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [b.id, b.version, [DID[4]]]);
    const [o1] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
    await q("update booking_offers set expires_at = now() - interval '1 second' where id = $1", [o1.id]);
    expect((await one(DU[4], "select driver_respond_offer($1, true) as r", [o1.id])).outcome).toBe("expired");

    b = await booking("STT-DEM006");
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [b.id, b.version, [DID[4]]]);
    const [o2] = await q("select id from booking_offers where booking_id = $1 and status = 'open'", [b.id]);
    b = await booking("STT-DEM006");
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [b.id, b.version, [DID[4]]]); // new generation
    expect((await one(DU[4], "select driver_respond_offer($1, true) as r", [o2.id])).outcome).toBe("already_taken");
    expect((await booking("STT-DEM006")).state).toBe("needs_driver");
  });

  it("a driver cannot answer someone else's offer", async () => {
    const [o] = await q("select id from booking_offers where status = 'open' limit 1");
    expect(await code(as(DU[0], "select driver_respond_offer($1, true)", [o.id]))).toBe("offer_not_found");
  });
});

describe("trip progress and earnings", () => {
  it("acceptance: completion retried → one earnings entry; cash tracked separately; no duplicate settlement rows", async () => {
    const d = 1; // Lucía: DEM002 confirmed, pay on pickup (cash)
    const jobs = await one(DU[d], "select driver_jobs() as r");
    const job = jobs.find((j: any) => j.reference === "STT-DEM002");
    expect(job.passenger.phone).toBe("+5491155550002");     // contact visible to the assigned driver
    let v = job.version;
    for (const stage of ["en_route", "at_pickup", "onboard", "complete"]) {
      const r = await one(DU[d], "select driver_trip_progress($1,$2,$3) as r", [job.assignmentId, stage, v]);
      v = r.version;
    }
    // Retries after completion (e.g. weak signal, reconnect) are no-ops.
    const again = await one(DU[d], "select driver_trip_progress($1,'complete',$2) as r", [job.assignmentId, v - 1]);
    expect(again.replay).toBe(true);
    await one(DU[d], "select driver_trip_progress($1,'complete',$2) as r", [job.assignmentId, v]);

    const earn = await q("select amount_minor from earnings_entries where assignment_id = $1", [job.assignmentId]);
    expect(earn).toEqual([{ amount_minor: "2560" }]);         // 80% of USD 32.00 (demo share)
    const cash = await q("select amount_minor from cash_entries where assignment_id = $1", [job.assignmentId]);
    expect(cash).toEqual([{ amount_minor: "3200" }]);
    const bk = await booking("STT-DEM002");
    expect([bk.state, bk.collection_state]).toEqual(["closed", "collected"]);
    const me = await one(DU[d], "select driver_me() as r");
    expect(me.earnings).toMatchObject({ accruedMinor: 2560, trips: 1 });
    expect(me.cashToHandInMinor).toBe(3200);
  });

  it("rejects skipped stages and stale versions", async () => {
    const jobs = await one(DU[2], "select driver_jobs() as r");   // Diego: DEM004
    const job = jobs.find((j: any) => j.reference === "STT-DEM004");
    expect(await code(as(DU[2], "select driver_trip_progress($1,'complete',$2)", [job.assignmentId, job.version]))).toBe("invalid_transition");
    await one(DU[2], "select driver_trip_progress($1,'en_route',$2) as r", [job.assignmentId, job.version]);
    expect(await code(as(DU[2], "select driver_trip_progress($1,'at_pickup',$2)", [job.assignmentId, job.version]))).toBe("stale_version");
  });

  it("acceptance: a driver cannot see or act on another driver's jobs or earnings", async () => {
    const lucia = (await one(DU[1], "select driver_jobs() as r")).map((j: any) => j.assignmentId);
    const diego = await one(DU[2], "select driver_jobs() as r");
    expect(diego.some((j: any) => lucia.includes(j.assignmentId))).toBe(false);
    expect(await code(as(DU[2], "select driver_trip_progress($1,'en_route',1)", [lucia[0]]))).toBe("job_not_found");
    expect(await as(DU[2], "select * from earnings_entries")).toEqual([]);
    expect(await as(DU[2], "select * from cash_entries")).toEqual([]);
    expect(await as(DU[2], "select * from assignments where driver_id = $1", [DID[1]])).toEqual([]);
    expect(await as(DU[2], "select * from bookings")).toEqual([]);
    expect((await as(FINANCE, "select * from earnings_entries")).length).toBe(1);
  });
});

describe("release, cancel and holds", () => {
  it("releasing a confirmed trip returns it to the queue and opens a passenger-impact exception", async () => {
    const b = await booking("STT-DEM005");
    expect(await code(as(DISPATCHER, "select dispatch_release($1,$2,'')", [b.id, b.version]))).toBe("reason_required");
    const r = await one(DISPATCHER, "select dispatch_release($1,$2,'Coche averiado') as r", [b.id, b.version]);
    expect(r.booking_state).toBe("needs_driver");
    const ex = await q("select kind from exceptions where booking_id = $1", [b.id]);
    expect(ex).toEqual([{ kind: "lost_cover" }]);
  });

  it("reassignment needs a reason and swaps drivers atomically", async () => {
    const b = await booking("STT-DEM007"); // Martín, confirmed
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3)", [b.id, DID[4], b.version]))).toBe("reason_required");
    await one(DISPATCHER, "select dispatch_assign($1,$2,$3,null,'Cambio de turno') as r", [b.id, DID[4], b.version]);
    const act = await q("select driver_id from assignments where booking_id = $1 and state <> 'released'", [b.id]);
    expect(act).toEqual([{ driver_id: DID[4] }]);
  });

  it("cancel releases the driver and supersedes offers", async () => {
    const b = await booking("STT-OVRLP1");
    await one(DISPATCHER, "select dispatch_cancel($1,$2,'Pasajero canceló') as r", [b.id, b.version]);
    const after = await booking("STT-OVRLP1");
    expect([after.state, after.cancelled_reason]).toEqual(["cancelled", "Pasajero canceló"]);
    expect(await code(as(DISPATCHER, "select dispatch_cancel($1,$2,'x')", [after.id, after.version]))).toBe("booking_closed");
  });

  it("with online payments live, a prepaid assignment is held and released on expiry", async () => {
    await q(`update policies set config = config || '{"payments_enabled": true}' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    try {
      const b = await cloneBooking("STT-DEM006", "STT-HOLD01", -60 * 9); // ~13:50 local, prepaid
      await one(DISPATCHER, "select dispatch_assign($1,$2,$3) as r", [b.id, DID[0], b.version]);
      const s = (await q("select * from assignments where booking_id = $1 and state <> 'released'", [b.id]))[0];
      expect([s.state, (await booking("STT-HOLD01")).state]).toEqual(["reserving", "held"]);
      await q("update assignments set hold_expires_at = now() - interval '1 second' where id = $1", [s.id]);
      await q("select app.expire_stale()");
      expect((await booking("STT-HOLD01")).state).toBe("needs_driver");
    } finally {
      await q(`update policies set config = config - 'payments_enabled' where operator_id = $1`, [DEMO_OPERATOR_ID]);
    }
  });
});

describe("live locations for the dispatch map", () => {
  it("only on-shift drivers report; out-of-order points are ignored; staff see the board, drivers only themselves", async () => {
    const d = 4; // Javier
    expect(await code(as(DU[d], "select driver_report_location(-34.6, -58.4)"))).toBe("off_shift");
    await as(DU[d], "select driver_set_shift(true)");
    const t1 = new Date(Date.now() - 5_000).toISOString();
    expect((await one(DU[d], "select driver_report_location(-34.6037, -58.3816, 8, 90, 10, $1) as r", [t1])).stored).toBe(true);
    expect((await one(DU[d], "select driver_report_location(-34.5, -58.5, 8, null, null, $1) as r", [new Date(Date.now() - 20_000).toISOString()])).reason).toBe("stale");
    expect(await code(as(DU[d], "select driver_report_location(-134, -58.5)"))).toBe("invalid_location");

    const board = await as(DISPATCHER, "select driver_id, lat, map_status, vehicle_plate from dispatch_driver_board where driver_id = $1", [DID[d]]);
    expect(board[0]).toMatchObject({ lat: -34.6037, map_status: "free", vehicle_plate: DEMO_VEHICLES[2].plate });
    expect(await as(DU[0], "select * from driver_locations where driver_id = $1", [DID[d]])).toEqual([]);
    expect((await as(DU[d], "select * from driver_locations")).length).toBe(1);

    // Driver en route shows as heading to pickup.
    const diego = 2;
    await as(DU[diego], "select driver_set_shift(true)");
    await as(DU[diego], "select driver_report_location(-34.82, -58.53)");
    const row = (await as(DISPATCHER, "select map_status, current_reference from dispatch_driver_board where driver_id = $1", [DID[diego]]))[0];
    expect(row).toEqual({ map_status: "to_pickup", current_reference: "STT-DEM004" });

    await as(DU[d], "select driver_set_shift(false)");
    const off = (await as(DISPATCHER, "select map_status, lat, recorded_at from dispatch_driver_board where driver_id = $1", [DID[d]]))[0];
    expect(off).toEqual({ map_status: "off", lat: null, recorded_at: null });       // position hidden off shift
    expect(await as(DISPATCHER, "select * from driver_locations where driver_id = $1", [DID[d]])).toEqual([]);
  });

  it("offers list hides passenger contact and exact address", async () => {
    const b = await booking("STT-DEM006");
    await one(DISPATCHER, "select dispatch_offer($1,$2,$3) as r", [b.id, b.version, [DID[4]]]);
    const offers = await one(DU[4], "select driver_offers() as r");
    expect(offers).toHaveLength(1);
    const text = JSON.stringify(offers[0]);
    expect(offers[0]).toMatchObject({ zone: "Palermo", airport: "EZE", earningsMinor: 2400 });
    expect(text).not.toContain("Gorriti");
    expect(text).not.toContain("+34600111222");
  });
});
