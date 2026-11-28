// Hotel/agency accounts with monthly invoices, and live transfer of Sofía's calls — against PostgreSQL.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_OPERATOR_ID, DEMO_STAFF } from "@shared/domain/fixtures.ts";
import { DB_URL } from "./pgStore.ts";

let pool: pg.Pool;
const [ADMIN, DISPATCHER, FINANCE] = [DEMO_STAFF[0].userId, DEMO_STAFF[1].userId, DEMO_STAFF[2].userId];
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
const save = (sub: string, name: string, discount = 10) =>
  as(sub, "select admin_save_account(null, $1, 'hotel', '30-1', 'f@h.test', null, null, $2, 30, true, null) as r", [name, discount]);

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  for (const s of DEMO_STAFF) {
    await q("insert into auth.users (id, email) values ($1, $2)", [s.userId, s.email]);
    await q("select app.grant_role_by_email('soytutaxi', $1, $2)", [s.email, s.role]);
  }
});
afterAll(async () => { await pool?.end(); });

describe("Accounts and monthly invoices", () => {
  it("bills account trips to the hotel: draft → issued → paid, with discount and terms", async () => {
    expect(await code(save(DISPATCHER, "Hotel X"))).toBe("forbidden");
    const acc = await save(FINANCE, "Hotel Alvear");
    expect(await code(save(FINANCE, "Hotel Alvear"))).toBe("account_exists");

    // Put two trips on the account (cash and prepaid-unpaid), then finish them.
    const refs = ["STT-DEM002", "STT-DEM005"];
    for (const ref of refs) {
      const b = await booking(ref);
      const r = await as(DISPATCHER, "select dispatch_set_account($1, $2, $3, 'Hab. 512') as r", [b.id, b.version, acc]);
      expect(r.paymentMode).toBe("account");
      expect(await code(as(DISPATCHER, "select dispatch_set_account($1, $2, $3, null) as r", [b.id, b.version, acc]))).toBe("stale_version");
    }
    const rows = await as(DISPATCHER, "select jsonb_agg(to_jsonb(x)) as r from dispatch_booking_rows x where reference = any($1)", [refs]);
    expect(rows.every((x: any) => x.account_name === "Hotel Alvear" && x.account_ref === "Hab. 512")).toBe(true);

    await q("update assignments set trip_stage = 'complete' where booking_id in (select id from bookings where reference = any($1)) and state <> 'released'", [refs]);
    await q("update bookings set state = 'closed', agreed_pickup_at = date_trunc('month', now()) + interval '2 days' where reference = any($1)", [refs]);
    // Closed trips can no longer be moved off the account.
    const b2 = await booking("STT-DEM002");
    expect(await code(as(DISPATCHER, "select dispatch_set_account($1, $2, null, null) as r", [b2.id, b2.version]))).toBe("booking_closed");

    const list = await as(FINANCE, "select finance_accounts() as r");
    const a = list.find((x: any) => x.id === acc);
    const sum = Number((await q("select sum(amount_minor) s from bookings where reference = any($1)", [refs]))[0].s);
    expect(a.unbilled[0]).toMatchObject({ amountMinor: sum, trips: 2 });

    expect(await code(as(FINANCE, "select finance_invoice_generate($1, (current_date - interval '1 month')::date) as r", [acc]))).toBe("nothing_to_invoice");
    const [inv] = await as(FINANCE, "select finance_invoice_generate($1, current_date) as r", [acc]);
    const doc = await as(FINANCE, "select finance_invoice($1) as r", [inv]);
    expect(doc).toMatchObject({ state: "draft", subtotalMinor: sum, discountMinor: Math.floor(sum / 10), totalMinor: sum - Math.floor(sum / 10) });
    expect(doc.number).toMatch(/^CTA-\d{6}-\d{4}$/);
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0].description).toMatch(/Hab\. 512/);
    // Already on a live invoice → not billed twice.
    expect(await code(as(FINANCE, "select finance_invoice_generate($1, current_date) as r", [acc]))).toBe("nothing_to_invoice");

    expect(await code(as(FINANCE, "select finance_invoice_state($1, 'paid') as r", [inv]))).toBe("invalid_transition");
    const issued = await as(FINANCE, "select finance_invoice_state($1, 'issued') as r", [inv]);
    expect(issued.dueOn).toBeTruthy();
    await as(FINANCE, "select finance_invoice_state($1, 'paid') as r", [inv]);
    expect((await q("select distinct collection_state::text c from bookings where reference = any($1)", [refs]))).toEqual([{ c: "collected" }]);
  });

  it("voiding an invoice frees its trips; the monthly job drafts last month for active accounts", async () => {
    const acc = await save(ADMIN, "Viajes Patagonia", 0);
    const b = await booking("STT-DEM006");
    await as(DISPATCHER, "select dispatch_set_account($1, $2, $3, null) as r", [b.id, b.version, acc]);
    await q("update bookings set state = 'closed', agreed_pickup_at = date_trunc('month', now()) - interval '10 days' where id = $1", [b.id]);
    expect((await q("select app.monthly_invoices() as n"))[0].n).toBe(1);
    const inv = (await q("select id from account_invoices where account_id = $1", [acc]))[0].id;
    await as(ADMIN, "select finance_invoice_state($1, 'void') as r", [inv]);
    expect((await q("select app.monthly_invoices() as n"))[0].n).toBe(1);     // the trip is billable again
  });

  it("taking a trip off an account returns it to cash; paid trips cannot go on an account", async () => {
    const acc = await save(ADMIN, "Empresa Y", 0);
    let b = await booking("STT-DEM001");
    await as(DISPATCHER, "select dispatch_set_account($1, $2, $3, null) as r", [b.id, b.version, acc]);
    b = await booking("STT-DEM001");
    await as(DISPATCHER, "select dispatch_set_account($1, $2, null, null) as r", [b.id, b.version]);
    b = await booking("STT-DEM001");
    expect(b).toMatchObject({ account_id: null, payment_mode: "pay_on_pickup_cash", collection_state: "pending_collection" });
    await q("update bookings set collection_state = 'collected' where id = $1", [b.id]);
    expect(await code(as(DISPATCHER, "select dispatch_set_account($1, $2, $3, null) as r", [b.id, b.version, acc]))).toBe("already_paid");
  });
});

describe("Live transfer from Sofía", () => {
  it("request → one desk agent claims it; a failed transfer becomes a callback", async () => {
    await q(`insert into wa_calls (operator_id, provider_call_id, wa_id, phone_e164, status, handled_by, bot_room)
             values ($1, 'wacid.T1', '5491100001111', '+5491100001111', 'active', 'bot', 'stt-room-1'),
                    ($1, 'wacid.T2', '5491100002222', '+5491100002222', 'active', 'bot', 'stt-room-2')`, [OP]);
    expect((await q("select wa_call_transfer_request('wacid.T1', 'Cambio de dirección') as r"))[0].r.ok).toBe(true);
    const id = (await q("select id from wa_calls where provider_call_id = 'wacid.T1'"))[0].id;
    const first = (await q("select * from wa_call_transfer_claim($1, $2)", [id, DISPATCHER]))[0];
    expect(first.bot_room).toBe("stt-room-1");
    expect((await q("select id from wa_call_transfer_claim($1, $2)", [id, ADMIN]))[0].id).toBeNull();   // only one person
    expect((await q("select wa_call_transfer_request('wacid.T1', 'otra vez') as r"))[0].r.ok).toBe(false);

    await q("select wa_call_transfer_request('wacid.T2', 'Queja')");
    await q("select wa_call_transfer_failed('wacid.T2')");
    const t2 = (await q("select * from wa_calls where provider_call_id = 'wacid.T2'"))[0];
    expect(t2.wants_callback).toBe(true);
    expect(t2.bot_note).toMatch(/nadie atendió.*Queja/);
    expect((await q("select id from wa_call_transfer_claim($1, $2)", [t2.id, ADMIN]))[0].id).toBeNull();
    expect(await code(as(DISPATCHER, "select wa_call_transfer_claim($1, $2) as r", [t2.id, DISPATCHER]))).toMatch(/permission denied/);
  });
});

describe("Customer memory", () => {
  it("shows the driver (first name, car, plate, stage) only once accepted, plus chat and calls; nothing for other numbers", async () => {
    const ctx = async (phone: string) => (await q("select wa_customer_context($1, $2) as r", [OP, phone]))[0].r;
    const b = await booking("STT-DEM004");          // needs a driver
    const phone = (await q("select phone_e164 from passengers where id = $1", [b.passenger_id]))[0].phone_e164;
    expect((await ctx(phone)).bookings.find((x: any) => x.reference === "STT-DEM004").driver).toBeNull();

    const conf = await booking("STT-DEM002");
    const p2 = (await q("select phone_e164 from passengers where id = $1", [conf.passenger_id]))[0].phone_e164;
    const conv = (await q(`insert into wa_conversations (operator_id, wa_id, phone_e164) values ($1, $2, $3) returning id`, [OP, p2.slice(1), p2]))[0].id;
    await q(`insert into wa_messages (operator_id, conversation_id, direction, kind, preview) values ($1, $2, 'in', 'text', '¿Dónde me espera el chofer?')`, [OP, conv]);
    await q(`insert into wa_calls (operator_id, provider_call_id, wa_id, phone_e164, status, handled_by, transcript, bot_note)
             values ($1, 'wacid.M1', $2, $3, 'ended', 'bot', 'Cliente: llego con 4 valijas', 'Trae 4 valijas')`, [OP, p2.slice(1), p2]);
    const m = await ctx(p2);
    const d = m.bookings.find((x: any) => x.reference === "STT-DEM002").driver;
    expect(d).toMatchObject({ firstName: expect.any(String), plate: expect.any(String) });
    expect(d).not.toHaveProperty("phone");
    expect(m.messages.at(-1)).toMatchObject({ from: "customer", text: "¿Dónde me espera el chofer?" });
    expect(m.calls.at(-1)).toMatchObject({ note: "Trae 4 valijas", transcript: "Cliente: llego con 4 valijas" });
    const other = await ctx("+5491100009999");
    expect(other).toMatchObject({ bookings: [], messages: [], calls: [] });
  });
});
