import { beforeEach, describe, expect, it } from "vitest";
import { handle, RateLimiter, type HandlerContext } from "@shared/api/handler.ts";
import { MemoryStore } from "@shared/api/memoryStore.ts";

let now = new Date("2026-11-26T15:00:00Z");
let store: MemoryStore;
let ctx: HandlerContext;
const SESSION = "sess_0123456789abcdef";

beforeEach(() => {
  now = new Date("2026-11-26T15:00:00Z");
  store = new MemoryStore(() => now);
  ctx = { store, statusTokenSecret: "test-secret", operatorSlug: "soytutaxi", publicAppUrl: "https://example.test", now: () => now };
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handle(new Request(`https://api.test/functions/v1/api${path}`, {
    method,
    headers: { "content-type": "application/json", "x-session-id": SESSION, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), ctx);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const journey = {
  direction: "from_airport", airport: "EZE", zoneCode: "palermo", place: { text: "Honduras 5600" },
  date: "2026-11-28", time: "08:00", flightDesignator: "AR1303", passengers: 4, largeBags: 4, carryOn: 0, locale: "en",
};
const contact = { name: "Demo Passenger", phone: "+447700900123", locale: "en" };

async function quoteAndBook(key = "989ae31b-ecb7-49c7-b016-ee571aa3b2b4") {
  const q = await call("POST", "/quotes", journey);
  const b = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": key });
  return { q, b };
}

describe("public API", () => {
  it("GET /config exposes public configuration only", async () => {
    const r = await call("GET", "/config");
    expect(r.status).toBe(200);
    expect(r.body.operator.demoMode).toBe(true);
    expect(r.body.airports.map((a: { iata: string }) => a.iata)).toEqual(["EZE", "AEP"]);
    expect(JSON.stringify(r.body)).not.toContain("fareRules");
  });

  it("POST /quotes returns minivan for 4 pax + 4 large bags with the sedan marked ineligible", async () => {
    const r = await call("POST", "/quotes", journey);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "priced", vehicleClass: "minivan", chargeCurrency: "USD", isDemo: true });
    expect(r.body.vehicleOptions.find((o: { code: string }) => o.code === "sedan_premium").eligible).toBe(false);
    expect(new Date(r.body.expiresAt).getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("POST /quotes 422 with field errors", async () => {
    const r = await call("POST", "/quotes", { ...journey, flightDesignator: "", date: "28/11/2026" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("invalid_journey");
    expect(r.body.error.fields.map((f: { field: string }) => f.field)).toEqual(expect.arrayContaining(["date", "flightDesignator"]));
    expect(r.body.error.requestId).toBeTruthy();
  });

  it("requires a session id and JSON", async () => {
    const r = await handle(new Request("https://api.test/api/quotes", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), ctx);
    expect(r.status).toBe(400);
    const r2 = await call("POST", "/quotes", undefined, { "content-type": "text/plain" });
    expect(r2.status).toBe(400);
  });

  it("POST /bookings creates a booking awaiting a driver (201) and queues side effects", async () => {
    const { b } = await quoteAndBook();
    expect(b.status).toBe(201);
    expect(b.body.bookingState).toBe("needs_driver");
    expect(b.body.reference).toMatch(/^STT-[A-Z0-9]{6}$/);
    expect(b.body.statusUrl).toContain(`/reserva/${b.body.reference}?t=`);
    expect(store.outbox.map((o) => o.kind)).toEqual(["notify.passenger.booking_received", "dispatch.needs_driver"]);
  });

  it("idempotent replay returns the original result; changed payload conflicts", async () => {
    const { q, b } = await quoteAndBook("key-aaaaaaaa");
    const replay = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "key-aaaaaaaa" });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ reference: b.body.reference, statusUrl: b.body.statusUrl, replay: true });
    const changed = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "pay_on_pickup_cash" }, { "idempotency-key": "key-aaaaaaaa" });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("idempotency_conflict");
    expect(store.bookings.size).toBe(1);
  });

  it("a quote can be consumed only once", async () => {
    const { q } = await quoteAndBook("key-first-000");
    const again = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "key-second-00" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("quote_already_used");
  });

  it("quotes are bound to the requesting session", async () => {
    const q = await call("POST", "/quotes", journey);
    const other = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" },
      { "idempotency-key": "key-other-000", "x-session-id": "someone_else_123456" });
    expect(other.status).toBe(404);
  });

  it("rejects expired quotes", async () => {
    const q = await call("POST", "/quotes", journey);
    now = new Date(now.getTime() + 31 * 60_000);
    const b = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "key-expired-0" });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe("quote_expired");
  });

  it("rejects unsupported payment modes and unreachable contacts", async () => {
    const q = await call("POST", "/quotes", journey);
    const card = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "pay_on_pickup_card" }, { "idempotency-key": "key-card-0000" });
    expect(card.status).toBe(422);
    expect(card.body.error.fields[0]).toMatchObject({ field: "paymentMode", code: "payment_mode_not_allowed" });
    const noContact = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact: { name: "X Y", locale: "en" }, paymentMode: "prepaid" }, { "idempotency-key": "key-nocontact" });
    expect(noContact.status).toBe(422);
  });

  it("manual quotes cannot be booked directly", async () => {
    const q = await call("POST", "/quotes", { ...journey, zoneCode: "tigre" });
    expect(q.body.kind).toBe("manual");
    const b = await call("POST", "/bookings", { quoteId: q.body.quoteId, contact, paymentMode: "prepaid" }, { "idempotency-key": "key-manual-00" });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe("manual_quote_required");
  });

  it("GET /bookings/:ref requires the matching status token", async () => {
    const { b } = await quoteAndBook("key-status-00");
    const token = b.body.statusToken;
    const ok = await call("GET", `/bookings/${b.body.reference}`, undefined, { "x-status-token": token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ reference: b.body.reference, bookingState: "needs_driver", vehicleClass: "minivan", driverAssigned: false });
    const bad = await call("GET", `/bookings/${b.body.reference}`, undefined, { "x-status-token": "x".repeat(43) });
    expect(bad.status).toBe(404);
    const noTok = await call("GET", `/bookings/${b.body.reference}`);
    expect(noTok.status).toBe(404);
  });

  it("only dispatchers may book airport pickups without a flight", async () => {
    const q = await call("POST", "/quotes", { ...journey, flightDesignator: null });
    expect(q.status).toBe(422);
    const staffHeaders = { authorization: "Bearer demo-dispatcher" };
    const sq = await call("POST", "/quotes", { ...journey, flightDesignator: null }, staffHeaders);
    expect(sq.status).toBe(201);
    const noReason = await call("POST", "/bookings", { quoteId: sq.body.quoteId, contact, paymentMode: "prepaid" }, { ...staffHeaders, "idempotency-key": "key-staff-000" });
    expect(noReason.body.error.code).toBe("flight_required");
    const ok = await call("POST", "/bookings", { quoteId: sq.body.quoteId, contact, paymentMode: "prepaid", flightExceptionReason: "Charter, sin número" }, { ...staffHeaders, "idempotency-key": "key-staff-001" });
    expect(ok.status).toBe(201);
    const finance = await call("POST", "/bookings", { quoteId: sq.body.quoteId, contact, paymentMode: "prepaid", flightExceptionReason: "x" }, { authorization: "Bearer demo-finance", "idempotency-key": "key-staff-002" });
    expect(finance.status).toBe(403);
  });

  it("rate limits per IP + session", async () => {
    ctx.rateLimiter = new RateLimiter(2, 60_000);
    expect((await call("GET", "/config")).status).toBe(200);
    expect((await call("GET", "/config")).status).toBe(200);
    expect((await call("GET", "/config")).status).toBe(429);
  });

  it("unknown routes are 404 with a consistent error body", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: "not_found" });
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("demo seed", () => {
  it("loads demo bookings for the dispatch schedule", () => {
    store.seedDemoBookings();
    const rows = store.dispatchRows();
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.driverName).length).toBe(4);
    expect(rows.find((r) => r.reference === "STT-DEM002")).toMatchObject({ vehicleClass: "minivan", driverName: "Lucía Fernández" });
  });
});
