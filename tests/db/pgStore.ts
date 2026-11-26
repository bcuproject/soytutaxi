// Node/pg implementation of Store for integration tests. Calls exactly the same SQL functions as
// SupabaseStore, running as the `service_role` database role.
import pg from "pg";
import { rowsToConfig } from "@shared/api/configMapping.ts";
import { ApiError, type Actor, type CreateBookingArgs, type QuoteRow, type Store } from "@shared/api/store.ts";

export const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/soytutaxi_test?host=/tmp";

export function mapPgError(e: pg.DatabaseError): Error {
  if (e.code === "P0001") return new ApiError(Number(e.detail) || 422, e.message, e.hint ?? e.message);
  if (e.code === "23P01") return new ApiError(409, "schedule_conflict");
  return e;
}

export class PgStore implements Store {
  constructor(public pool: pg.Pool) {}

  async asService<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role service_role");
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e instanceof pg.DatabaseError ? mapPgError(e) : e;
    } finally {
      c.release();
    }
  }

  loadConfig(slug: string) {
    return this.asService(async (c) => {
      const op = (await c.query("select * from operators where slug = $1", [slug])).rows[0];
      if (!op) return null;
      const all = (t: string) => c.query(`select * from ${t} where operator_id = $1`, [op.id]).then((r) => r.rows);
      // Sequential: one pg client cannot run queries concurrently.
      const vc = await all("vehicle_classes");
      const ap = await all("airports");
      const zn = await all("zones");
      const fr = (await c.query("select *, effective::text as effective from fare_rules where operator_id = $1 and active", [op.id])).rows;
      const pol = (await c.query("select * from policies where operator_id = $1 and effective_from <= now() order by version desc limit 1", [op.id])).rows[0];
      return rowsToConfig(op, vc, ap, zn, fr, pol);
    });
  }

  insertQuote(row: QuoteRow) {
    const j = row.journey;
    return this.asService(async (c) => {
      const r = await c.query(
        `insert into quotes (operator_id, session_hash, source, kind, direction, airport_id, zone_id, vehicle_class, passengers, large_bags,
           carry_on, pickup_at, journey, fare, amount_minor, currency, fare_rule_id, fare_rule_version, policy_id, manual_reasons, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
        [row.operatorId, row.sessionHash, row.source, row.kind, j.direction, j.airportId, j.zoneId, row.vehicleClass, j.passengers,
         j.largeBags, j.carryOn, j.pickupAt, j, row.fare, row.fare?.totalMinor ?? null, row.fare?.currency ?? null,
         row.fare?.fareRuleId ?? null, row.fare?.fareRuleVersion ?? null, row.policyId, row.manualReasons, row.expiresAt]);
      return { id: r.rows[0].id as string };
    });
  }

  createBooking(a: CreateBookingArgs) {
    return this.asService(async (c) => {
      const r = await c.query(
        "select create_booking_from_quote($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r",
        [a.operatorId, a.quoteId, a.sessionHash, a.idempotencyKey, a.requestHash, a.contact, a.paymentMode, a.notes,
         a.statusTokenHash, a.actorId, a.flightExceptionReason, a.requestId]);
      const d = r.rows[0].r;
      return { bookingId: d.booking_id, reference: d.reference, state: d.state, replay: d.replay };
    });
  }

  getBookingStatus(reference: string, hash: string) {
    return this.asService(async (c) => (await c.query("select get_booking_status($1,$2) as r", [reference, hash])).rows[0].r);
  }

  /** Tests use bearer "user:<uuid>" to stand in for a verified Supabase JWT. */
  async resolveActor(bearer: string, operatorId: string): Promise<Actor | null> {
    const m = /^user:(.+)$/.exec(bearer);
    if (!m) return null;
    const rows = await this.asService((c) => c.query(
      "select role from memberships where operator_id = $1 and user_id = $2 and active", [operatorId, m[1]]).then((r) => r.rows));
    return rows.length ? { userId: m[1], roles: rows.map((r) => r.role) } : null;
  }
}
