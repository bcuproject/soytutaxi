// Driver documents (expiry → alerts → blocking), pay statements and settlement, reports — against PostgreSQL.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_DRIVERS, DEMO_OPERATOR_ID, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const [ADMIN, DISPATCHER, FINANCE] = [DEMO_STAFF[0].userId, DEMO_STAFF[1].userId, DEMO_STAFF[2].userId];
const DU = "88888888-0000-4000-8000-000000000001";
const DID = DEMO_DRIVERS.map((d) => d.id);
const OP = DEMO_OPERATOR_ID;

async function as(sub: string, sql: string, params: unknown[] = []): Promise<any> {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub]);
    const r = await c.query(sql, params); await c.query("commit"); return r.rows[0]?.r;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const booking = async (ref: string) => (await q("select * from bookings where reference = $1", [ref]))[0];
const vehicleOf = async (driver: string) => (await q("select app.driver_vehicle_at($1, now()) as v", [driver]))[0].v;
const doc = (sub: string, driver: string | null, vehicle: string | null, kind: string, expires: string) =>
  as(sub, "select admin_set_document(null, $1, $2, $3, 'N-1', $4::date, null) as r", [driver, vehicle, kind, expires]);

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  for (const s of DEMO_STAFF) {
    await q("insert into auth.users (id, email) values ($1, $2)", [s.userId, s.email]);
    await q("select app.grant_role_by_email('soytutaxi', $1, $2)", [s.email, s.role]);
  }
  await q("insert into auth.users (id, email) values ($1, 'driver1@demo.test')", [DU]);
  await q("select app.link_driver_by_email($1, 'driver1@demo.test')", [DID[0]]);
});
afterAll(async () => { await pool?.end(); });

describe("Driver documents", () => {
  it("warn only until enforcement is on; then missing/expired documents block assignment", async () => {
    const b = await booking("STT-DEM001");
    const v = await vehicleOf(DID[0]);
    const view = await as(DISPATCHER, "select dispatch_compliance() as r");
    expect(view.enforce).toBe(false);
    expect(view.drivers.find((d: any) => d.id === DID[0]).problem).toBe("documents_missing:insurance");
    expect(await code(as(FINANCE, "select admin_set_compliance(true, 30) as r"))).toBe("forbidden");
    await as(ADMIN, "select admin_set_compliance(true, 30) as r");

    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3) as r", [b.id, DID[0], b.version]))).toBe("documents_missing");
    const far = "2030-01-01";
    await doc(DISPATCHER, DID[0], null, "license", far);
    await doc(DISPATCHER, DID[0], null, "professional_license", far);
    await doc(DISPATCHER, null, v, "insurance", far);
    await doc(DISPATCHER, null, v, "vtv", far);
    // Permit expires the day before the trip → still refused.
    const tripDay = (await q("select (agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date - 1 as d from bookings where id = $1", [b.id]))[0].d;
    const permit = await doc(DISPATCHER, null, v, "permit", tripDay.toISOString().slice(0, 10));
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3) as r", [b.id, DID[0], b.version]))).toBe("documents_expired");
    // Renewed (same row, upsert by kind) → allowed.
    expect(await doc(DISPATCHER, null, v, "permit", far)).toBe(permit);
    expect(await code(as(DISPATCHER, "select dispatch_assign($1,$2,$3) as r", [b.id, DID[0], b.version]))).toBe("ok");
    await as(ADMIN, "select admin_set_compliance(false, 30) as r");
  });

  it("daily alerts: expiring (warning) and expired (critical), once each; renewal resolves", async () => {
    const v = await vehicleOf(DID[0]);
    const id = await doc(ADMIN, null, v, "insurance", new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10));
    await doc(ADMIN, DID[1], null, "license", "2020-01-01");
    expect((await q("select app.document_alerts() as n"))[0].n).toBe(2);
    expect((await q("select app.document_alerts() as n"))[0].n).toBe(0);
    const ex = await q("select kind, severity::text from exceptions where kind like 'document_%' and state <> 'resolved' order by kind");
    expect(ex).toEqual([{ kind: "document_expired", severity: "critical" }, { kind: "document_expiring", severity: "warning" }]);
    await doc(ADMIN, null, v, "insurance", "2031-01-01");
    expect((await q("select state::text from exceptions where evidence ->> 'document_id' = $1", [id]))[0].state).toBe("resolved");
    // The driver sees their own documents.
    const st = await as(DU, "select driver_statement() as r");
    expect(st.documents.map((d: any) => d.kind)).toEqual(expect.arrayContaining(["license", "insurance"]));
  });
});

describe("Driver statements and settlement", () => {
  it("net = earnings − cash collected; settling closes the lines into a batch", async () => {
    const [b1, b2] = [await booking("STT-DEM002"), await booking("STT-DEM005")];
    await q(`insert into earnings_entries (operator_id, driver_id, booking_id, kind, amount_minor, currency) values
             ($1, $2, $3, 'trip', 3000000, 'ARS'), ($1, $2, $4, 'trip', 2000000, 'ARS')`, [OP, DID[0], b1.id, b2.id]);
    const a1 = (await q("select id from assignments where booking_id = $1 and state <> 'released'", [b1.id]))[0].id;
    await q(`insert into cash_entries (operator_id, driver_id, assignment_id, booking_id, amount_minor, currency) values ($1, $2, $3, $4, 4000000, 'ARS')`, [OP, DID[0], a1, b1.id]);
    expect(await code(as(DISPATCHER, "select finance_overview() as r"))).toBe("forbidden");
    expect(await code(as(FINANCE, "select finance_adjustment($1, 50000, 'ARS', '') as r", [DID[0]]))).toBe("reason_required");
    await as(FINANCE, "select finance_adjustment($1, -50000, 'ARS', 'Peaje no correspondía') as r", [DID[0]]);

    const st = await as(FINANCE, "select finance_statement($1, now()) as r", [DID[0]]);
    expect(st.totals).toEqual([{ currency: "ARS", earningsMinor: 4950000, cashMinor: 4000000, netMinor: 950000, trips: 2 }]);
    expect(st.lines).toHaveLength(4);

    const out = await as(FINANCE, "select finance_settle($1, now(), 'Transferencia 28/11') as r", [DID[0]]);
    expect(out[0]).toMatchObject({ currency: "ARS", netMinor: 950000 });
    expect(await code(as(FINANCE, "select finance_settle($1, now(), null) as r", [DID[0]]))).toBe("nothing_to_settle");
    const after = await as(FINANCE, "select finance_statement($1, now()) as r", [DID[0]]);
    expect(after.totals).toEqual([]);
    expect(after.batches[0]).toMatchObject({ netMinor: 950000, trips: 2, note: "Transferencia 28/11" });
    const past = await as(FINANCE, "select finance_statement($1, now(), $2) as r", [DID[0], out[0].batchId]);
    expect(past.lines).toHaveLength(4);

    const mine = await as(DU, "select driver_statement($1) as r", [out[0].batchId]);
    expect(mine.totals[0].netMinor).toBe(950000);
    expect((await as(DU, "select driver_me() as r")).cashToHandInMinor).toBe(0);
    expect(await code(as(DU, "select driver_statement($1) as r", ["00000000-0000-4000-8000-000000000000"]))).toBe("not_found");
  });
});

describe("Reports", () => {
  it("summarises bookings, revenue, ratings and drivers for a date range", async () => {
    const b = await booking("STT-DEM002");
    await q("update assignments set trip_stage = 'complete' where booking_id = $1 and state <> 'released'", [b.id]);
    await q("update bookings set state = 'closed' where id = $1", [b.id]);
    const a = (await q("select id, driver_id from assignments where booking_id = $1 and state <> 'released'", [b.id]))[0];
    await q("update earnings_entries set assignment_id = $1 where booking_id = $2", [a.id, b.id]);
    await q("insert into ratings (booking_id, operator_id, driver_id, score, via) values ($1, $2, $3, 4, 'web')", [b.id, OP, a.driver_id]);
    const day = (await q("select (agreed_pickup_at at time zone 'America/Argentina/Buenos_Aires')::date::text as d from bookings where id = $1", [b.id]))[0].d;
    expect(await code(as(DISPATCHER, "select report_summary($1::date, ($1::date - 1)) as r", [day]))).toBe("invalid_range");
    const r = await as(DISPATCHER, "select report_summary(($1::date - 3), ($1::date + 3)) as r", [day]);
    expect(r.completed).toBe(1);
    expect(r.bookings).toBeGreaterThanOrEqual(6);
    expect(r.revenue[0]).toMatchObject({ trips: 1 });
    expect(r.ratings).toMatchObject({ count: 1, average: 4, low: 0 });
    expect(r.daily).toHaveLength(7);
    expect(r.drivers[0]).toMatchObject({ driverId: a.driver_id, trips: 1, rating: 4, earningsMinor: 3000000 });
    expect(r.byAirport.AEP).toBeGreaterThanOrEqual(1);
    expect(await code(as(DU, "select report_summary(current_date, current_date) as r"))).toBe("forbidden");
  });
});
