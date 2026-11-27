// Passenger self-service: cancellation with policy refunds (web token + phone), ratings, reminders — against PostgreSQL.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const OP = "11111111-1111-4111-8111-111111111111";
const TOKEN = "status-token-for-tests-0123456789";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

async function setup(ref: string, hoursAhead: number) {
  await q(`update bookings set agreed_pickup_at = date_trunc('minute', now()) + make_interval(hours => $2::int),
             status_token_hash = $3, status_token_expires_at = now() + interval '30 days' where reference = $1`, [ref, hoursAhead, HASH]);
  await q(`update assignments s set occupied = tstzrange(b.agreed_pickup_at, b.agreed_pickup_at + interval '90 minutes', '[)')
             from bookings b where b.id = s.booking_id and b.reference = $1 and s.state <> 'released'`, [ref]);
  return one("select * from bookings where reference = $1", [ref]);
}
const preview = (ref: string) => one("select passenger_cancel_preview($1, $2) as r", [ref, HASH]).then((x) => x.r);
const cancel = (ref: string, reason: string | null = null) => one("select passenger_cancel($1, $2, $3) as r", [ref, HASH, reason]).then((x) => x.r);
const status = (ref: string) => one("select get_booking_status($1, $2) as r", [ref, HASH]).then((x) => x.r);

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
});
afterAll(async () => { await pool?.end(); });

describe("Passenger cancellation", () => {
  it("more than 24 h ahead: full refund of the fare payment, driver released, notifications queued", async () => {
    const b = await setup("STT-DEM007", 48);   // confirmed, prepaid, with a driver
    await q(`insert into payments (operator_id, booking_id, provider_payment_id, status, amount_minor, currency, approved_at, is_fare_payment)
             values ($1, $2, 'mp-test-1', 'approved', 5000000, 'ARS', now(), true)`, [OP, b.id]);
    expect((await status("STT-DEM007")).allowedActions).toContain("cancel");
    const t = await preview("STT-DEM007");
    expect(t).toMatchObject({ allowed: true, refundPercent: 100, paidMinor: 5000000, refundMinor: 5000000 });

    const r = await cancel("STT-DEM007", "Cambié de vuelo");
    expect(r.cancelled).toBe(true);
    const after = await one("select * from bookings where id = $1", [b.id]);
    expect(after).toMatchObject({ state: "cancelled", cancelled_by: "passenger" });
    expect(after.version).toBe(b.version + 1);
    expect((await q("select 1 from assignments where booking_id = $1 and state <> 'released'", [b.id])).length).toBe(0);
    const jobs = (await q("select kind from outbox_jobs where payload ->> 'booking_id' = $1::text or payload ->> 'refund_id' in (select id::text from refunds where booking_id = $1::uuid)", [b.id])).map((j) => j.kind);
    expect(jobs).toEqual(expect.arrayContaining(["notify.passenger.cancelled", "payment.refund"]));
    expect((await one("select amount_minor, state from refunds where booking_id = $1", [b.id]))).toMatchObject({ amount_minor: "5000000", state: "requested" });
    expect((await one("select severity from exceptions where booking_id = $1 and kind = 'passenger_cancelled'", [b.id])).severity).toBe("info");
    // A second attempt is refused and does not refund twice.
    expect(await err(cancel("STT-DEM007"))).toBe("already_cancelled");
    expect((await q("select 1 from refunds where booking_id = $1", [b.id])).length).toBe(1);
    expect((await status("STT-DEM007")).allowedActions).toEqual([]);
  });

  it("inside 24 h an unpaid booking is cancelled with no refund rows; refund percent follows the policy", async () => {
    const b = await setup("STT-DEM006", 5);
    const t = await preview("STT-DEM006");
    expect(t).toMatchObject({ allowed: true, refundPercent: 50, paidMinor: 0, refundMinor: 0 });
    await cancel("STT-DEM006");
    expect((await q("select 1 from refunds where booking_id = $1", [b.id])).length).toBe(0);
  });

  it("is refused once the driver is on the way, and for a wrong token or another phone", async () => {
    const b = await setup("STT-DEM005", 4);
    await q("update assignments set trip_stage = 'en_route' where booking_id = $1 and state <> 'released'", [b.id]);
    expect((await preview("STT-DEM005"))).toMatchObject({ allowed: false, reason: "driver_on_the_way" });
    expect(await err(cancel("STT-DEM005"))).toBe("driver_on_the_way");
    expect((await status("STT-DEM005")).allowedActions).not.toContain("cancel");
    expect(await err(one("select passenger_cancel('STT-DEM002', 'wrong', null)"))).toBe("booking_not_found");
    expect(await err(one("select wa_passenger_cancel($1, '+5491100000000', 'STT-DEM002', true)", [OP]))).toBe("booking_not_found");
  });

  it("the phone version previews first and cancels on confirm", async () => {
    await setup("STT-DEM002", 30);
    const t = (await one("select wa_passenger_cancel($1, '+5491155550002', 'stt-dem002', false) as r", [OP])).r;
    expect(t.allowed).toBe(true);
    expect((await one("select state from bookings where reference = 'STT-DEM002'")).state).toBe("confirmed");
    const r = (await one("select wa_passenger_cancel($1, '+5491155550002', 'STT-DEM002', true, 'voice') as r", [OP])).r;
    expect(r.cancelled).toBe(true);
    expect((await one("select cancelled_reason from bookings where reference = 'STT-DEM002'")).cancelled_reason).toMatch(/voice/);
  });

  it("partial refund after the free window", async () => {
    const b = await setup("STT-DEM003", 6);   // held, prepaid
    await q(`insert into payments (operator_id, booking_id, provider_payment_id, status, amount_minor, currency, approved_at, is_fare_payment)
             values ($1, $2, 'mp-test-3', 'approved', 4000000, 'ARS', now(), true)`, [OP, b.id]);
    const r = await cancel("STT-DEM003");
    expect(r).toMatchObject({ refundPercent: 50, refundMinor: 2000000 });
    expect((await one("select amount_minor from refunds where booking_id = $1", [b.id])).amount_minor).toBe("2000000");
  });
});

describe("Ratings", () => {
  it("asks 20 minutes after a completed trip; low scores raise an exception; status shows the rating", async () => {
    const b = await setup("STT-DEM001", 30);
    // Give it a completed assignment and close it.
    const d = await one("select id from drivers where operator_id = $1 order by full_name limit 1", [OP]);
    const v = await one("select id from vehicles where operator_id = $1 order by plate limit 1", [OP]);
    await q(`insert into assignments (operator_id, booking_id, driver_id, vehicle_id, state, trip_stage, occupied)
             values ($1, $2, $3, $4, 'confirmed', 'complete', tstzrange(now() + interval '400 days', now() + interval '400 days 90 minutes', '[)'))`, [OP, b.id, d.id, v.id]);
    await q("update bookings set state = 'closed' where id = $1", [b.id]);
    const job = await one("select next_attempt_at - now() as wait from outbox_jobs where kind = 'notify.passenger.rating' and payload ->> 'booking_id' = $1", [b.id]);
    expect(job).toBeTruthy();
    expect((await status("STT-DEM001")).allowedActions).toEqual(["rate"]);

    expect(await err(one("select passenger_rate($1, $2, 7, null)", ["STT-DEM001", HASH]))).toBe("invalid_score");
    await one("select passenger_rate($1, $2, 2, null)", ["STT-DEM001", HASH]);
    expect((await one("select severity from exceptions where booking_id = $1 and kind = 'low_rating'", [b.id])).severity).toBe("warning");
    // The comment arrives later (WhatsApp) and is attached to the open exception.
    await one("select wa_rate($1, '+447700900001', $2, 2, 'El chofer llegó tarde')", [OP, b.id]);
    expect((await one("select summary from exceptions where booking_id = $1 and kind = 'low_rating'", [b.id])).summary).toMatch(/llegó tarde/);
    expect(await one("select score, comment, driver_id from ratings where booking_id = $1", [b.id])).toMatchObject({ score: 2, comment: "El chofer llegó tarde", driver_id: d.id });
    const s = await status("STT-DEM001");
    expect(s.rating).toBe(2);
    expect(s.allowedActions).toEqual([]);
    expect(await err(one("select wa_rate($1, '+5491100000000', $2, 5, null)", [OP, b.id]))).toBe("booking_not_found");
  });

  it("cannot rate a trip that has not finished", async () => {
    await setup("STT-DEM004", 30);
    expect(await err(one("select passenger_rate('STT-DEM004', $1, 5, null)", [HASH]))).toBe("not_completed");
  });
});

describe("Day-before reminders", () => {
  it("queues once for confirmed trips 3–24 h ahead during the day, never at night", async () => {
    // A fresh confirmed trip: reuse DEM005 (confirmed) and reset its stage.
    const b = await setup("STT-DEM005", 20);
    await q("update assignments set trip_stage = 'scheduled' where booking_id = $1 and state <> 'released'", [b.id]);
    const ba = (h: number) => `(date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') + interval '${h} hours') at time zone 'America/Argentina/Buenos_Aires'`;
    // 03:00 local → nothing.
    expect((await one(`select app.queue_reminders(${ba(3)}) as n`)).n).toBe(0);
    // Put the pickup 20 h after 12:00 local, then run at 12:00.
    await q(`update bookings set agreed_pickup_at = ${ba(12)} + interval '20 hours' where id = $1`, [b.id]);
    expect((await one(`select app.queue_reminders(${ba(12)}) as n`)).n).toBe(1);
    expect((await one(`select app.queue_reminders(${ba(12)}) as n`)).n).toBe(0);      // only once
    expect((await q("select 1 from outbox_jobs where kind = 'notify.passenger.reminder' and payload ->> 'booking_id' = $1", [b.id])).length).toBe(1);
  });
});
