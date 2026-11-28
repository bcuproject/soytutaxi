// Driver registration: dispatch adds a driver + vehicle and invites them; drivers apply themselves and wait for
// approval — against PostgreSQL.
import { createHash, randomUUID } from "node:crypto";
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
const hash = (t: string) => createHash("sha256").update(`driver-invite:${t}`).digest("hex");
const save = (sub: string, id: string | null, name: string, phone: string, cls: string, plate: string) =>
  as(sub, "select admin_save_driver($1, $2, $3, $4, $5, 'Toyota Corolla gris') as r", [id, name, phone, cls, plate]);

beforeAll(async () => {
  execFileSync("bash", ["scripts/db-reset.sh"], { stdio: "pipe" });
  pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
  for (const s of DEMO_STAFF) {
    await q("insert into auth.users (id, email) values ($1, $2)", [s.userId, s.email]);
    await q("select app.grant_role_by_email('soytutaxi', $1, $2)", [s.email, s.role]);
  }
});
afterAll(async () => { await pool?.end(); });

describe("Driver registration", () => {
  it("dispatch adds a driver with a vehicle, invites them, and the invitation sets up their login once", async () => {
    const cls = (await as(DISPATCHER, "select vehicle_class_options() as r"))[0].code;
    expect(await code(save(FINANCE, null, "Pedro Gómez", "+54 9 11 5555-0101", cls, "AB 123 CD"))).toBe("forbidden");
    expect(await code(save(DISPATCHER, null, "Pe", "+5491155550101", cls, "AB123CD"))).toBe("invalid_name");
    expect(await code(save(DISPATCHER, null, "Pedro Gómez", "12", cls, "AB123CD"))).toBe("invalid_phone");
    expect(await code(save(DISPATCHER, null, "Pedro Gómez", "+5491155550101", "spaceship", "AB123CD"))).toBe("invalid_vehicle_class");

    const { id } = await save(DISPATCHER, null, "Pedro Gómez", "+54 9 11 5555-0101", cls, "ab 123 cd");
    const row = (await as(DISPATCHER, "select admin_drivers() as r")).find((d: any) => d.id === id);
    expect(row).toMatchObject({ fullName: "Pedro Gómez", whatsapp: "+5491155550101", status: "approved", source: "staff", hasLogin: false,
      vehicle: { plate: "AB123CD", vehicleClass: cls } });
    expect(await code(save(DISPATCHER, null, "Otro", "+5491155550101", cls, "ZZ999ZZ"))).toBe("phone_in_use");
    // The same car can't be driven by two drivers at once.
    const other = await save(DISPATCHER, null, "Juan Pérez", "+5491155550102", cls, "XY987ZW");
    expect(await code(save(DISPATCHER, other.id, "Juan Pérez", "+5491155550102", cls, "AB123CD"))).toBe("vehicle_in_use");
    // Changing a driver's car closes the old allocation.
    await save(DISPATCHER, other.id, "Juan Pérez", "+5491155550102", cls, "QQ111QQ");
    expect((await as(DISPATCHER, "select admin_drivers() as r")).find((d: any) => d.id === other.id).vehicle.plate).toBe("QQ111QQ");

    const inv = await as(DISPATCHER, "select admin_driver_invite($1) as r", [id]);
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await q("select count(*)::int n from app.driver_invites where token_hash = $1", [inv.token])) [0].n).toBe(0); // never stored plain
    // A new invitation replaces the old one.
    const inv2 = await as(DISPATCHER, "select admin_driver_invite($1) as r", [id]);
    expect((await q("select public.driver_invite_peek($1) r", [hash(inv.token)]))[0].r).toBeNull();
    expect((await q("select public.driver_invite_peek($1) r", [hash(inv2.token)]))[0].r).toMatchObject({ driverId: id, name: "Pedro Gómez" });
    // Only the server may read or redeem invitations.
    expect(await code(as(ADMIN, "select driver_invite_peek($1) as r", [hash(inv2.token)]))).toMatch(/permission denied/);

    const user = randomUUID();
    await q("insert into auth.users (id, email) values ($1, 'pedro@chofer.test')", [user]);
    await q("select public.driver_invite_claim($1, $2, 'Pedro@Chofer.test')", [hash(inv2.token), user]);
    expect(await code(q("select public.driver_invite_claim($1, $2, 'x@y.test')", [hash(inv2.token), user]))).toBe("invalid_invite");
    const d = (await q("select auth_user_id, email, whatsapp_verified_at from drivers where id = $1", [id]))[0];
    expect(d.auth_user_id).toBe(user); expect(d.email).toBe("pedro@chofer.test"); expect(d.whatsapp_verified_at).not.toBeNull();
    // The driver can now use the driver app.
    expect((await as(user, "select driver_me() as r")).fullName ?? (await as(user, "select driver_me() as r")).full_name).toBeTruthy();
    expect(await code(as(DISPATCHER, "select admin_driver_invite($1) as r", [id]))).toBe("driver_has_login");
  });

  it("a driver applies, waits as pending (no trips), then dispatch approves them", async () => {
    const cls = (await q("select public.vehicle_class_options() r"))[0].r[0].code;
    const user = randomUUID();
    await q("insert into auth.users (id, email) values ($1, 'ana@chofer.test')", [user]);
    const { id } = (await q("select public.driver_signup($1, $2, 'ana@chofer.test', 'Ana Ruiz', '+5491155550201', $3, 'AC 555 TT', 'Fiat Cronos') r",
      [OP, user, cls]))[0].r;
    expect(await as(user, "select driver_application() as r")).toMatchObject({ status: "pending", fullName: "Ana Ruiz" });
    expect(await code(as(user, "select driver_me() as r"))).toBe("not_a_driver");
    // Same phone can't apply twice.
    const u2 = randomUUID();
    await q("insert into auth.users (id, email) values ($1, 'ana2@chofer.test')", [u2]);
    expect(await code(q("select public.driver_signup($1, $2, 'ana2@chofer.test', 'Ana R', '+54 9 11 5555-0201', $3, 'AC555TU', null)", [OP, u2, cls])))
      .toBe("phone_in_use");

    const list = await as(DISPATCHER, "select admin_drivers() as r");
    expect(list[0]).toMatchObject({ id, status: "pending", source: "signup", hasLogin: true, vehicle: { plate: "AC555TT" } });   // pending first

    expect(await code(as(FINANCE, "select admin_set_driver_approval($1, 'approved') as r", [id]))).toBe("forbidden");
    const ok = await as(DISPATCHER, "select admin_set_driver_approval($1, 'approved', 'Documentos vistos') as r", [id]);
    expect(ok).toMatchObject({ status: "approved", name: "Ana Ruiz", whatsapp: "+5491155550201" });
    expect(await as(user, "select driver_application() as r")).toMatchObject({ status: "approved" });
    expect(await code(as(user, "select driver_me() as r"))).toBe("ok");
    expect((await q("select whatsapp_verified_at from drivers where id = $1", [id]))[0].whatsapp_verified_at).not.toBeNull();
    // Suspending takes them off shift.
    await q("update drivers set on_shift = true where id = $1", [id]);
    await as(ADMIN, "select admin_set_driver_approval($1, 'suspended', 'Licencia vencida') as r", [id]);
    expect((await q("select on_shift, approval_status from drivers where id = $1", [id]))[0]).toEqual({ on_shift: false, approval_status: "suspended" });
  });
});
