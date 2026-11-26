// Integration tests against real PostgreSQL. Prereq: scripts/db-reset.sh (run automatically below).
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle, type HandlerContext } from "@shared/api/handler.ts";
import { DEMO_AIRPORTS, DEMO_DRIVERS, DEMO_OPERATOR_ID, DEMO_STAFF, DEMO_VEHICLES, DEMO_ZONES } from "@shared/domain/fixtures.ts";
import { addDaysLocal, utcToLocalDate } from "@shared/domain/time.ts";
import { DB_URL, PgStore } from "./pgStore.ts";

let pool: pg.Pool;
let store: PgStore;
let ctx: HandlerContext;
const SESSION = "dbtest_session_000001";
const ADMIN = DEMO_STAFF[0].userId, DISPATCHER = DEMO_STAFF[1].userId, FINANCE = DEMO_STAFF[2].userId;
const DRIVER_USER = "88888888-0000-4000-8000-000000000001";
const DRIVER_USER_2 = "88888888-0000-4000-8000-000000000002";
const inTwoDays = addDaysLocal(utcToLocalDate(new Date()), 2);

const journey = {
  direction: "from_airport", airport: "EZE", zoneCode: "palermo", place: { text: "Honduras 5600" },
  date: inTwoDays, time: "08:00", flightDesignator: "AR1303", passengers: 4, largeBags: 4, carryOn: 0, locale: "en",
};
const contact = { name: "Demo Passenger", phone: "+447700900123", locale: "en" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handle(new Request(`https://x.supabase.co/functions/v1/api${path}`, {
    method, headers: { "content-type": "application/json", "x-session-id": SESSION, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), ctx);
  return { status: res.status, body: await res.json() };
}

/** Run SQL as a given Supabase role / JWT subject, inside a rolled-back transaction. */
async function as<T = pg.QueryResultRow>(role: "anon" | "authenticated", sub: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    if (sub) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }
}

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 20 });
  store = new PgStore(pool);
  ctx = { store, statusTokenSecret: "db-test-secret", operatorSlug: "soytutaxi", publicAppUrl: "https://example.test" };
  // Staff users + memberships, and two driver auth users.
  await pool.query(`insert into auth.users (id, email) values ($1,$2),($3,$4),($5,$6),($7,'driver1@demo.test'),($8,'driver2@demo.test')`,
    [ADMIN, DEMO_STAFF[0].email, DISPATCHER, DEMO_STAFF[1].email, FINANCE, DEMO_STAFF[2].email, DRIVER_USER, DRIVER_USER_2]);
  for (const s of DEMO_STAFF) await pool.query("select app.grant_role_by_email('soytutaxi', $1, $2)", [s.email, s.role]);
  await pool.query("update drivers set auth_user_id = $1 where id = $2", [DRIVER_USER, DEMO_DRIVERS[0].id]);
  await pool.query("update drivers set auth_user_id = $1 where id = $2", [DRIVER_USER_2, DEMO_DRIVERS[1].id]);
});

afterAll(async () => { await pool?.end(); });

describe("booking API on PostgreSQL", () => {
  it("quote → booking → status, with one outbox job per side effect", async () => {
    const q = await call("POST", "/quotes", journey);
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ kind: "priced", vehicleClass: "minivan" });
    const b = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "db-key-0001" });
    expect(b.status).toBe(201);
    expect(b.body.bookingState).toBe("needs_driver");

    const s = await call("GET", `/bookings/${b.body.reference}`, undefined, { "x-status-token": b.body.statusToken });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ bookingState: "needs_driver", airport: "EZE", vehicleClass: "minivan", amountMinor: 4500, currency: "USD", collectionState: "awaiting_payment" });

    const row = (await pool.query("select b.*, q.consumed_booking_id from bookings b join quotes q on q.id = b.quote_id where reference = $1", [b.body.reference])).rows[0];
    expect(row.consumed_booking_id).toBe(row.id);
    expect(row.status_token_hash).not.toContain(b.body.statusToken);           // only the hash is stored
    expect(row.dropoff_place.originalText).toBe("Honduras 5600");              // original text preserved
    const jobs = (await pool.query("select kind from outbox_jobs where payload->>'booking_id' = $1 order by kind", [row.id])).rows;
    expect(jobs.map((j) => j.kind)).toEqual(["dispatch.needs_driver", "notify.passenger.booking_received"]);
    const audit = (await pool.query("select action from audit_log where entity_id = $1", [row.id])).rows;
    expect(audit).toEqual([{ action: "booking.create" }]);
  });

  it("10 concurrent identical requests (same key) → exactly one booking, all callers get its reference", async () => {
    const q = await call("POST", "/quotes", journey);
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "db-key-race-same" })));
    const refs = new Set(results.map((r) => r.body.reference));
    expect(refs.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.replay)).toHaveLength(9);
    const n = (await pool.query("select count(*)::int n from bookings where idempotency_key = 'db-key-race-same'")).rows[0].n;
    expect(n).toBe(1);
  });

  it("10 concurrent requests with different keys for one quote → one booking, nine 409s", async () => {
    const q = await call("POST", "/quotes", journey);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": `db-key-race-${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === "quote_already_used")).toHaveLength(9);
  });

  it("changed payload under the same key → 409", async () => {
    const q = await call("POST", "/quotes", journey);
    await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "db-key-conflict" });
    const r = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact: { ...contact, name: "Someone Else" }, paymentMode: "prepaid" }, { "idempotency-key": "db-key-conflict" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("idempotency_conflict");
  });

  it("expiry is checked with database time", async () => {
    const q = await call("POST", "/quotes", journey);
    await pool.query("update quotes set expires_at = now() - interval '1 second' where id = $1", [q.body.quoteId]);
    const r = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "db-key-expired" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("quote_expired");
  });

  it("staff can book an airport pickup without a flight only with a recorded reason", async () => {
    const auth = { authorization: `Bearer user:${DISPATCHER}` };
    const q = await call("POST", "/quotes", { ...journey, flightDesignator: null }, auth);
    expect(q.status).toBe(201);
    const r = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "pay_on_pickup_cash", flightExceptionReason: "Vuelo privado" }, { ...auth, "idempotency-key": "db-key-staff-01" });
    expect(r.status).toBe(201);
    const row = (await pool.query("select source, flight_exception_reason, flight_exception_by, collection_state from bookings where reference = $1", [r.body.reference])).rows[0];
    expect(row).toEqual({ source: "staff", flight_exception_reason: "Vuelo privado", flight_exception_by: DISPATCHER, collection_state: "pending_collection" });
  });

  it("passenger roles cannot call the booking command or read tables directly", async () => {
    await expect(as("anon", null, "select create_booking_from_quote(null,null,null,null,null,null,null,null,null)")).rejects.toThrow(/permission denied/);
    expect(await as("anon", null, "select * from bookings")).toEqual([]);
    expect(await as("anon", null, "select * from fare_rules")).toEqual([]);
  });
});

describe("schedule integrity constraints", () => {
  const bookingIds = async () => (await pool.query("select id, reference from bookings where reference in ('STT-DEM001','STT-DEM004','STT-DEM006') order by reference")).rows;

  it("rejects overlapping active assignments for the same driver (and same vehicle), allows after release", async () => {
    const [b1, b4] = await bookingIds();
    const c = await pool.connect();
    try {
      await c.query("begin");
      const ins = (bid: string, driver: string, vehicle: string, from: string, to: string) => c.query(
        `insert into assignments (operator_id, booking_id, driver_id, vehicle_id, state, occupied) values ($1,$2,$3,$4,'confirmed', tstzrange($5,$6,'[)')) returning id`,
        [DEMO_OPERATOR_ID, bid, driver, vehicle, from, to]);
      const a1 = await ins(b1.id, DEMO_DRIVERS[2].id, DEMO_VEHICLES[1].id, "2030-01-01T10:00Z", "2030-01-01T11:00Z");
      await c.query("savepoint s");
      await expect(ins(b4.id, DEMO_DRIVERS[2].id, DEMO_VEHICLES[2].id, "2030-01-01T10:30Z", "2030-01-01T11:30Z")).rejects.toMatchObject({ code: "23P01", constraint: "assignment_driver_no_overlap" });
      await c.query("rollback to savepoint s");
      await expect(ins(b4.id, DEMO_DRIVERS[4].id, DEMO_VEHICLES[1].id, "2030-01-01T10:30Z", "2030-01-01T11:30Z")).rejects.toMatchObject({ code: "23P01", constraint: "assignment_vehicle_no_overlap" });
      await c.query("rollback to savepoint s");
      // Half-open ranges: back-to-back jobs are fine.
      await ins(b4.id, DEMO_DRIVERS[2].id, DEMO_VEHICLES[1].id, "2030-01-01T11:00Z", "2030-01-01T12:00Z");
      await c.query("rollback to savepoint s");
      await c.query("update assignments set state = 'released', released_reason = 'test' where id = $1", [a1.rows[0].id]);
      await ins(b4.id, DEMO_DRIVERS[2].id, DEMO_VEHICLES[1].id, "2030-01-01T10:30Z", "2030-01-01T11:30Z");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("allows at most one active assignment per booking", async () => {
    const [, , b6] = await bookingIds();
    const c = await pool.connect();
    try {
      await c.query("begin");
      const ins = (driver: string, vehicle: string) => c.query(
        `insert into assignments (operator_id, booking_id, driver_id, vehicle_id, state, hold_expires_at, occupied) values ($1,$2,$3,$4,'reserving', now() + interval '15 minutes', tstzrange('2031-01-01T10:00Z','2031-01-01T11:00Z','[)'))`,
        [DEMO_OPERATOR_ID, b6.id, driver, vehicle]);
      await ins(DEMO_DRIVERS[2].id, DEMO_VEHICLES[1].id);
      await expect(ins(DEMO_DRIVERS[4].id, DEMO_VEHICLES[2].id)).rejects.toMatchObject({ code: "23505", constraint: "assignments_one_active_per_booking" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("rejects ambiguous fare rules at write time", async () => {
    await expect(pool.query(
      `insert into fare_rules (operator_id, direction, airport_id, zone_id, vehicle_class, rank, amount_minor, currency, est_duration_min, effective)
       values ($1, 'from_airport', $2, $3, 'sedan_premium', 100, 3100, 'USD', 55, daterange('2026-06-01', null, '[)'))`,
      [DEMO_OPERATOR_ID, DEMO_AIRPORTS[0].id, DEMO_ZONES[0].id])).rejects.toMatchObject({ code: "23P01", constraint: "fare_rules_unambiguous" });
  });

  it("enforces the airport-pickup flight rule at the table level", async () => {
    await expect(pool.query("update bookings set flight_designator = null where reference = 'STT-DEM001'"))
      .rejects.toMatchObject({ code: "23514", constraint: "airport_pickup_needs_flight" });
  });
});

describe("row-level security", () => {
  it("dispatcher sees every booking of the operator in the dispatch view", async () => {
    const rows = await as("authenticated", DISPATCHER, "select reference, driver_name from dispatch_booking_rows where reference like 'STT-DEM%' order by reference");
    expect(rows).toHaveLength(8);
    expect(rows[1]).toEqual({ reference: "STT-DEM002", driver_name: "Lucía Fernández" });
  });

  it("an authenticated non-member sees nothing", async () => {
    expect(await as("authenticated", "77777777-0000-4000-8000-000000000000", "select id from bookings")).toEqual([]);
    expect(await as("authenticated", "77777777-0000-4000-8000-000000000000", "select id from dispatch_booking_rows")).toEqual([]);
  });

  it("a driver sees only their own driver row and assignments, never bookings or other drivers' work", async () => {
    const own = await as<{ id: string }>("authenticated", DRIVER_USER, "select id from drivers");
    expect(own.map((r) => r.id)).toEqual([DEMO_DRIVERS[0].id]);
    const asg = await as<{ driver_id: string }>("authenticated", DRIVER_USER, "select driver_id from assignments");
    expect(asg.length).toBe(2); // DEM003 (held) + DEM007
    expect(new Set(asg.map((a) => a.driver_id))).toEqual(new Set([DEMO_DRIVERS[0].id]));
    expect(await as("authenticated", DRIVER_USER, "select id from bookings")).toEqual([]);
    expect(await as("authenticated", DRIVER_USER, "select id from passengers")).toEqual([]);
    const other = await as("authenticated", DRIVER_USER, "select id from assignments where driver_id = $1", [DEMO_DRIVERS[1].id]);
    expect(other).toEqual([]);
  });

  it("only admins can change configuration; finance and dispatch cannot", async () => {
    const upd = "update vehicle_classes set max_large_bags = max_large_bags where code = 'sedan_premium' returning code";
    expect(await as("authenticated", ADMIN, upd)).toHaveLength(1);
    expect(await as("authenticated", FINANCE, upd)).toEqual([]);
    expect(await as("authenticated", DISPATCHER, upd)).toEqual([]);
  });

  it("nobody but the service role writes bookings", async () => {
    await expect(as("authenticated", ADMIN, "update bookings set notes = 'x' where reference = 'STT-DEM001' returning id")).resolves.toEqual([]);
    await expect(as("authenticated", DISPATCHER, `insert into bookings (operator_id) values ('${DEMO_OPERATOR_ID}')`)).rejects.toThrow(/row-level security|null value/);
  });

  it("audit log is admin-only", async () => {
    expect((await as("authenticated", ADMIN, "select id from audit_log")).length).toBeGreaterThan(0);
    expect(await as("authenticated", DISPATCHER, "select id from audit_log")).toEqual([]);
  });
});
