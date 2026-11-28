import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@shared/api/memoryStore.ts";
import type { Extractor } from "@shared/whatsapp/ai.ts";
import { handleMessage, typedPayment, type ConversationState, type EngineDeps } from "@shared/whatsapp/engine.ts";
import { parseWebhook, previewOf, toGraphPayload, verifySignature, type InboundMessage, type Outbound } from "@shared/whatsapp/meta.ts";
import { extractAll, parseDate, parseFlight, parseTime, parseZone } from "@shared/whatsapp/parse.ts";
import { demoOperatorConfig } from "@shared/domain/fixtures.ts";

const NOW = new Date("2026-11-27T12:00:00Z"); // 09:00 in Buenos Aires, Friday
const cfg = demoOperatorConfig();
let store: MemoryStore;
let conv: ConversationState;
let seq = 0;
let deps: EngineDeps;

beforeEach(() => {
  store = new MemoryStore(() => NOW);
  conv = { id: "c1", operatorId: cfg.operatorId, waId: "447700900123", profileName: "Emma Wilson", kind: "passenger", locale: "es-AR", step: "menu", draft: {} };
  deps = {
    cfg, now: NOW, store, ai: null, statusTokenSecret: "s", publicAppUrl: "https://example.test/soytutaxi",
    bookingsForPhone: async (phone) => [...store.bookings.values()].filter((b) => b.contact.phone === phone).map((b) => ({
      reference: b.reference, state: b.state, pickupAt: b.journey.pickupAt, direction: b.journey.direction, airport: b.journey.airportIata,
      zone: "Palermo", idempotencyKey: b.idempotencyKey,
    })),
  };
});

const msg = (m: Partial<InboundMessage>): InboundMessage => ({ id: `wamid.${++seq}`, from: conv.waId, timestamp: 0, rawType: m.type ?? "text", type: "text", ...m });
/** Send a message, apply the resulting state, return the replies. */
async function send(m: string | { reply: string } | { lat: number; lng: number; name?: string }): Promise<Outbound[]> {
  const inbound = typeof m === "string" ? msg({ type: "text", text: m })
    : "reply" in m ? msg({ type: "reply", replyId: m.reply, replyTitle: m.reply })
    : msg({ type: "location", location: m });
  const r = await handleMessage(conv, inbound, deps);
  conv = { ...conv, step: r.step, draft: r.draft, locale: r.locale };
  (send as unknown as { last: typeof r }).last = r;
  return r.replies;
}
const last = () => (send as unknown as { last: Awaited<ReturnType<typeof handleMessage>> }).last;
const all = (rs: Outbound[]) => rs.map(previewOf).join("\n---\n");
const ids = (rs: Outbound[]) => rs.flatMap((r) => (r.type === "buttons" ? r.buttons.map((b) => b.id) : r.type === "list" ? r.rows.map((x) => x.id) : []));

describe("WhatsApp booking — guided buttons", () => {
  it("books end to end with buttons and lists (Spanish)", async () => {
    expect(all(await send("hola"))).toContain("SoyTuTaxi");
    expect(ids(await send({ reply: "menu:book" }))).toEqual(["dir:from_airport", "dir:to_airport", "menu:staff"]);
    expect(ids(await send({ reply: "dir:from_airport" }))).toEqual(["ap:EZE", "ap:AEP"]);
    expect(ids(await send({ reply: "ap:EZE" }))).toContain("zone:palermo");
    expect(all(await send({ reply: "zone:palermo" }))).toContain("dirección o el hotel en *Palermo*");
    expect(ids(await send("Honduras 5600"))).toEqual(["date:today", "date:tomorrow"]);
    expect(all(await send({ reply: "date:tomorrow" }))).toContain("aterriza");
    expect(all(await send("10:30"))).toContain("número de vuelo");
    expect(ids(await send("ar 1303"))).toContain("pax:2");
    expect(ids(await send({ reply: "pax:2" }))).toContain("bags:2");
    expect(ids(await send({ reply: "bags:2" }))).toContain("carry:1");
    const review = all(await send({ reply: "carry:1" }));
    expect(review).toContain("EZE → Honduras 5600 (Palermo)");
    expect(review).toContain("AR1303 · 10:30");
    expect(review).toContain("Sedán Premium");
    expect(review).toMatch(/USD\s*30,00/);
    expect(review).toContain("60 min después del aterrizaje");
    expect(ids(await send({ reply: "review:confirm" }))).toEqual(["name:profile"]);
    expect(ids(await send({ reply: "name:profile" }))).toEqual(["pay:prepaid", "pay:pay_on_pickup_cash"]);
    const done = all(await send({ reply: "pay:prepaid" }));
    expect(done).toMatch(/Recibimos tu solicitud STT-[A-Z0-9]{6}/);
    expect(done).toContain("no está confirmada");
    expect(done).toContain("https://example.test/soytutaxi/reserva/STT-");
    expect(conv.step).toBe("done");
    const [b] = [...store.bookings.values()];
    expect(b).toMatchObject({ source: "whatsapp", state: "needs_driver", paymentMode: "prepaid", contact: { name: "Emma Wilson", phone: "+447700900123" } });
    expect(b.journey.flight?.designator).toBe("AR1303");
  });

  it("typed answers at the end finish the booking (no loop between summary and payment)", async () => {
    conv.draft = { direction: "to_airport", airport: "AEP", zoneCode: "recoleta", placeText: "Alvear 1891", date: "2026-11-28", time: "08:00", passengers: 2, largeBags: 1, carryOn: 2 };
    conv.step = "direction";
    await send({ reply: "carry:2" });                       // → review (as in the 28/11 test chat)
    expect(conv.step).toBe("review");
    expect(ids(await send("confirmar"))).toEqual(["name:profile"]);
    expect(ids(await send("nicolas"))).toEqual(["pay:prepaid", "pay:pay_on_pickup_cash"]);   // straight to payment, not the summary again
    const unclear = all(await send("no sé"));
    expect(unclear).toContain("escribí *online* o *efectivo*");
    expect(conv.step).toBe("payment");
    const done = all(await send("pagon online"));
    expect(done).toMatch(/Recibimos tu solicitud STT-[A-Z0-9]{6}/);
    expect(conv.step).toBe("done");
    expect([...store.bookings.values()].at(-1)).toMatchObject({ paymentMode: "prepaid", contact: { name: "nicolas" } });
  });

  it("reads typed payment choices", () => {
    const both = ["prepaid", "pay_on_pickup_cash"];
    expect(typedPayment("pago online", both)).toBe("prepaid");
    expect(typedPayment("Mercado Pago", both)).toBe("prepaid");
    expect(typedPayment("efectivo", both)).toBe("pay_on_pickup_cash");
    expect(typedPayment("cash", both)).toBe("pay_on_pickup_cash");
    expect(typedPayment("2", both)).toBe("pay_on_pickup_cash");
    expect(typedPayment("tarjeta", both)).toBe("prepaid");
    expect(typedPayment("hola", both)).toBeNull();
  });

  it("a second tap on Confirm does not create a second booking", async () => {
    conv.draft = { direction: "to_airport", airport: "AEP", zoneCode: "recoleta", placeText: "Alvear 1891", date: "2026-11-28", time: "08:00", passengers: 1, largeBags: 1, carryOn: 0, name: "Ana", paymentMode: "pay_on_pickup_cash" };
    conv.step = "direction";
    await send({ reply: "carry:0" });                  // → review
    const first = all(await send({ reply: "review:confirm" }));
    const again = all(await send({ reply: "review:confirm" }));
    expect(store.bookings.size).toBe(1);
    expect(again).toContain(first.match(/STT-[A-Z0-9]{6}/)![0]);
  });
});

describe("WhatsApp booking — free text", () => {
  it("understands a whole booking in one Spanish message, then asks only what's missing", async () => {
    const r = await send("Hola! Llego a Ezeiza mañana 10:30 en el AR1303, voy a Palermo, somos 4 personas con 4 valijas y 0 de mano");
    expect(all(r)).toContain("dirección o el hotel en *Palermo*");
    const review = all(await send("Honduras 5600"));
    expect(review).toContain("Minivan");                          // 4 large cases don't fit a sedan
    expect(review).toMatch(/USD\s*45,00/);
  });

  it("with AI, extracts the address too and goes straight to the price", async () => {
    const ai: Extractor = { extract: async () => ({ direction: "from_airport", airport: "EZE", zone: "palermo", address: "Hotel Fierro, Soler 5862", date: "2026-11-28", time: "10:30", flight: "AR1303", passengers: 2, large_bags: 2, carry_on: 2, language: "es" }) };
    deps.ai = ai;
    const r = all(await send("necesito un taxi mañana desde ezeiza al hotel fierro, llego en el AR1303 a las 10:30, somos dos con 2 valijas y 2 de mano"));
    expect(r).toContain("Revisá tu viaje");
    expect(r).toContain("Hotel Fierro, Soler 5862");
  });

  it("ignores invalid AI values (unknown zone, bad date) and asks instead", async () => {
    deps.ai = { extract: async () => ({ zone: "mar_del_plata", date: "2026-02-30", passengers: 99 }) };
    const r = await send("I want to go somewhere far away next week please");
    expect(conv.draft.zoneCode).toBeUndefined();
    expect(conv.draft.date).toBeUndefined();
    expect(conv.draft.passengers).toBeUndefined();
    expect(ids(r)).toEqual(["menu:book", "menu:check", "menu:staff"]);   // nothing usable → menu
  });

  it("switches to English automatically", async () => {
    const r = all(await send("Hi, I need a taxi to the airport tomorrow"));
    expect(conv.locale).toBe("en");
    expect(r).toMatch(/Which airport\?/);
  });

  it("asks which date when day/month order is ambiguous (English)", async () => {
    conv.locale = "en";
    conv.draft = { direction: "to_airport", airport: "EZE", zoneCode: "recoleta", placeText: "Posadas 1350" };
    conv.step = "date";
    // 1/12 could be 1 Dec or 12 Jan — both bookable → ask.
    expect(ids(await send("1/12")).sort()).toEqual(["date:2026-12-01", "date:2027-01-12"]);
    await send({ reply: "date:2027-01-12" });
    expect(conv.draft.date).toBe("2027-01-12");
    // 12/11 could be 11 Dec or 12 Nov 2027 — only one is within 180 days → no question.
    conv.draft.date = undefined; conv.step = "date";
    await send("12/11");
    expect(conv.draft.date).toBe("2026-12-11");
  });

  it("enforces lead time with a friendly message", async () => {
    conv.draft = { direction: "to_airport", airport: "EZE", zoneCode: "recoleta", placeText: "Posadas 1350", date: "2026-11-27", passengers: 1, largeBags: 1, carryOn: 0 };
    conv.step = "time";
    const r = all(await send("10:00"));                           // 1 h from now
    expect(r).toContain("al menos 3 h");
    expect(conv.step).toBe("time");
  });

  it("a pinned location sets the zone", async () => {
    conv.draft = { direction: "to_airport", airport: "AEP" };
    conv.step = "zone";
    await send({ lat: -34.58, lng: -58.43, name: "Hotel Magnolia" });
    expect(conv.draft).toMatchObject({ zoneCode: "palermo", placeText: "Hotel Magnolia", lat: -34.58 });
    const outside = all(await send({ lat: -31.4, lng: -64.18 }));  // Córdoba
    expect(outside).toContain("fuera de nuestras zonas");
  });
});

describe("WhatsApp booking — people and edge cases", () => {
  it("hands over to staff on request and stays quiet until staff answer", async () => {
    await send("quiero hablar con una persona");
    expect(last().needsStaff).toBe(true);
    expect(conv.step).toBe("handoff");
    expect(all(await send("hola?"))).toBe("");                     // staffWait already sent with handoff
    expect(await send("sigo esperando")).toEqual([]);
  });

  it("unpriced routes go to staff as a manual quote", async () => {
    conv.draft = { direction: "from_airport", airport: "EZE", zoneCode: "tigre", placeText: "Av. Cazón 1000", date: "2026-11-28", time: "10:00", flight: "AR1303", passengers: 2, largeBags: 1 };
    conv.step = "carry";
    const r = all(await send({ reply: "carry:0" }));
    expect(r).toContain("se cotiza a mano");
    expect(last().needsStaff).toBe(true);
  });

  it("changing passengers from the review re-asks and reprices", async () => {
    conv.draft = { direction: "to_airport", airport: "EZE", zoneCode: "recoleta", placeText: "Posadas 1350", date: "2026-11-28", time: "08:00", passengers: 2, largeBags: 2 };
    conv.step = "carry";
    await send({ reply: "carry:0" });
    expect(ids(await send({ reply: "review:change" }))).toContain("change:people");
    expect(ids(await send({ reply: "change:people" }))).toContain("pax:4");
    await send({ reply: "pax:4" }); await send({ reply: "bags:5" });
    expect(all(await send({ reply: "carry:0" }))).toContain("Minivan");
  });

  it("an expired price is refreshed at confirm", async () => {
    conv.draft = { direction: "to_airport", airport: "EZE", zoneCode: "recoleta", placeText: "Posadas 1350", date: "2026-11-28", time: "08:00", passengers: 1, largeBags: 1 };
    conv.step = "carry";
    await send({ reply: "carry:0" });
    conv.draft.quoteExpiresAt = new Date(NOW.getTime() - 1000).toISOString();
    expect(all(await send({ reply: "review:confirm" }))).toContain("venció");
  });

  it("'mi reserva' lists the passenger's bookings with status links", async () => {
    conv.draft = { direction: "to_airport", airport: "AEP", zoneCode: "recoleta", placeText: "Alvear 1891", date: "2026-11-28", time: "08:00", passengers: 1, largeBags: 1, carryOn: 0, name: "Ana", paymentMode: "pay_on_pickup_cash" };
    conv.step = "carry";
    await send({ reply: "carry:0" }); await send({ reply: "review:confirm" });
    const r = all(await send("mi reserva"));
    expect(r).toMatch(/STT-[A-Z0-9]{6}.*buscando chofer/s);
    expect(r).toContain("/reserva/STT-");
  });

  it("drivers can accept an offer with the WhatsApp button", async () => {
    conv = { ...conv, kind: "driver", driverId: "d1" };
    let called: unknown[] = [];
    deps.driverRespond = async (...a) => { called = a; return { outcome: "accepted", reference: "STT-ABC234" }; };
    const r = all(await send({ reply: "offer:0ae3d3b4-226e-4a3e-af67-db244cf9d348:a" }));
    expect(called).toEqual(["d1", "0ae3d3b4-226e-4a3e-af67-db244cf9d348", true]);
    expect(r).toContain("STT-ABC234");
  });
});

describe("parsers", () => {
  const today = "2026-11-27";
  it("dates in Spanish and English", () => {
    expect(parseDate("mañana", today, "es-AR")).toEqual({ date: "2026-11-28" });
    expect(parseDate("pasado mañana", today, "es-AR")).toEqual({ date: "2026-11-29" });
    expect(parseDate("28/11", today, "es-AR")).toEqual({ date: "2026-11-28" });
    expect(parseDate("3/1", today, "es-AR")).toEqual({ date: "2027-01-03" });           // next year
    expect(parseDate("5 de diciembre", today, "es-AR")).toEqual({ date: "2026-12-05" });
    expect(parseDate("Dec 5th", today, "en")).toEqual({ date: "2026-12-05" });
    expect(parseDate("12/5", today, "en")?.options).toHaveLength(2);
    expect(parseDate("30/2", today, "es-AR")).toBeNull();
  });
  it("times", () => {
    expect(parseTime("14:30")).toBe("14:30");
    expect(parseTime("a las 9")).toBe("09:00");
    expect(parseTime("10pm")).toBe("22:00");
    expect(parseTime("12am")).toBe("00:00");
    expect(parseTime("22hs")).toBe("22:00");
    expect(parseTime("9.15")).toBe("09:15");
    expect(parseTime("hola")).toBeNull();
  });
  it("flights, zones and counts", () => {
    expect(parseFlight("vuelo ar 1303")).toBe("AR1303");
    expect(parseFlight("LA-4521 llega")).toBe("LA4521");
    expect(parseFlight("Honduras 5600")).toBeNull();
    expect(parseFlight("at 6pm and 1 bag")).toBeNull();
    expect(parseFlight("a las 9")).toBeNull();
    expect(parseFlight("LA 4521")).toBe("LA4521");
    expect(parseZone("voy a puerto madero", cfg.zones)).toBe("puerto_madero");
    expect(parseZone("hotel en las cañitas", cfg.zones)).toBe("palermo");
    const e = extractAll("2 adults, 3 suitcases and 1 carry-on from AEP on Dec 5 at 6pm", cfg.zones, today, "en");
    expect(e).toMatchObject({ passengers: 2, largeBags: 3, carryOn: 1, airport: "AEP", date: "2026-12-05", time: "18:00", direction: "from_airport", language: "en" });
  });
});

describe("Meta webhook format", () => {
  const body = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "123456" },
      contacts: [{ wa_id: "5491155550002", profile: { name: "Lucía" } }],
      messages: [
        { id: "wamid.A", from: "5491155550002", timestamp: "1795800000", type: "text", text: { body: "hola" } },
        { id: "wamid.B", from: "5491155550002", timestamp: "1795800001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "dir:to_airport", title: "Hacia" } } },
        { id: "wamid.C", from: "5491155550002", timestamp: "1795800002", type: "location", location: { latitude: -34.58, longitude: -58.43, name: "Casa" } },
        { id: "wamid.D", from: "5491155550002", timestamp: "1795800003", type: "image", image: { id: "x" } },
      ],
      statuses: [{ id: "wamid.OUT", status: "failed", recipient_id: "5491155550002", errors: [{ code: 131047, title: "Re-engagement message" }] }],
    } }] }],
  };
  it("parses messages, replies, locations and statuses", () => {
    const p = parseWebhook(body);
    expect(p.phoneNumberId).toBe("123456");
    expect(p.messages.map((m) => m.type)).toEqual(["text", "reply", "location", "other"]);
    expect(p.messages[0].profileName).toBe("Lucía");
    expect(p.messages[1].replyId).toBe("dir:to_airport");
    expect(p.messages[2].location).toMatchObject({ lat: -34.58, lng: -58.43 });
    expect(p.statuses[0]).toMatchObject({ id: "wamid.OUT", status: "failed", error: "131047: Re-engagement message" });
  });
  it("verifies the X-Hub-Signature-256 header over the raw body", async () => {
    const raw = JSON.stringify(body);
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");
    expect(await verifySignature(raw, sig, "app-secret")).toBe(true);
    expect(await verifySignature(raw + " ", sig, "app-secret")).toBe(false);
    expect(await verifySignature(raw, sig, "other")).toBe(false);
    expect(await verifySignature(raw, null, "app-secret")).toBe(false);
  });
  it("respects WhatsApp size limits on buttons and lists", () => {
    const p = toGraphPayload("549", { type: "buttons", text: "x", buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: "A very long button title here" })) }) as any;
    expect(p.interactive.action.buttons).toHaveLength(3);
    expect(p.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    const l = toGraphPayload("549", { type: "list", text: "x", button: "Elegir", rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: "Row title that is far too long" })) }) as any;
    expect(l.interactive.action.sections[0].rows).toHaveLength(10);
    expect(l.interactive.action.sections[0].rows[0].title.length).toBeLessThanOrEqual(24);
  });
});

describe("WhatsApp self-service — cancel and rate", () => {
  const terms = (over: Record<string, unknown> = {}) => ({
    allowed: true, reason: null, refundPercent: 100, freeUntilHoursBefore: 24, freeUntil: NOW.toISOString(), paidMinor: 5000000,
    refundMinor: 5000000, currency: "ARS", reference: "STT-AB12CD", pickupAt: "2026-11-29T15:00:00Z", paymentMode: "prepaid", ...over,
  });

  it("lists bookings with a cancel button, asks for confirmation with the refund, then cancels", async () => {
    const calls: [string, string, boolean][] = [];
    deps.bookingsForPhone = async () => [{ reference: "STT-AB12CD", state: "confirmed", pickupAt: "2026-11-29T15:00:00Z", direction: "from_airport", airport: "EZE", zone: "Palermo", idempotencyKey: "k".repeat(20) }];
    deps.cancelBooking = async (phone, ref, ok) => { calls.push([phone, ref, ok]); return ok ? { ...terms(), cancelled: true } : terms(); };
    const list = await send({ reply: "menu:check" });
    expect(ids(list)).toContain("bk:cancel:STT-AB12CD");
    const ask = await send({ reply: "bk:cancel:STT-AB12CD" });
    expect(all(ask)).toMatch(/total pagado/);
    expect(ids(ask)).toEqual(["bk:cancelok:STT-AB12CD", "bk:keep:STT-AB12CD"]);
    const done = await send({ reply: "bk:cancelok:STT-AB12CD" });
    expect(all(done)).toMatch(/cancelamos la reserva \*STT-AB12CD\*.*reembolso/s);
    expect(calls).toEqual([["+447700900123", "STT-AB12CD", false], ["+447700900123", "STT-AB12CD", true]]);
  });

  it("explains a refusal and keeps the booking on 'No'", async () => {
    deps.cancelBooking = async () => terms({ allowed: false, reason: "driver_on_the_way" });
    expect(all(await send({ reply: "bk:cancel:STT-AB12CD" }))).toMatch(/chofer ya está en camino/);
    expect(all(await send({ reply: "bk:keep:STT-AB12CD" }))).toMatch(/sigue en pie/);
  });

  it("a low rating asks for a comment and saves it", async () => {
    const saved: unknown[] = [];
    deps.rate = async (_p, id, n, c) => { saved.push([id, n, c]); return { score: n }; };
    const id = "0b5c1a3e-1111-4222-8333-444455556666";
    expect(all(await send({ reply: `rate:${id}:5` }))).toMatch(/Gracias por tu calificación/);
    expect(all(await send({ reply: `rate:${id}:1` }))).toMatch(/qué pasó/);
    expect(conv.step).toBe("rate_comment");
    expect(all(await send("El auto estaba sucio"))).toMatch(/Gracias por contarnos/);
    expect(saved).toEqual([[id, 5, null], [id, 1, null], [id, 1, "El auto estaba sucio"]]);
    expect(conv.step).toBe("done");
  });
});

describe("Reminder and rating notifications", () => {
  it("composes the reminder (confirmed only) and the rating list", async () => {
    const { composeNotification } = await import("@shared/whatsapp/notify.ts");
    const ctx = {
      bookingId: "0b5c1a3e-1111-4222-8333-444455556666", reference: "STT-AB12CD", state: "confirmed", source: "whatsapp", direction: "from_airport" as const,
      airport: "EZE", zone: "Palermo", pickupAt: "2026-11-28T15:00:00Z", flight: "AR1303", passengers: 2, largeBags: 2, amountMinor: 5000000, currency: "ARS",
      idempotencyKey: "k".repeat(20), operatorId: cfg.operatorId,
      passenger: { name: "Emma", phone: "+447700900123", locale: "en", lastInboundAt: NOW.toISOString() },
      driver: { id: "d", name: "Carlos Gómez", phone: null, verified: true, plate: "AB123CD", vehicle: "Toyota Corolla", lastInboundAt: null }, offer: null,
    };
    const opts = { now: NOW, timezone: cfg.timezone, publicAppUrl: "https://x.test", statusTokenSecret: "s", templates: {} };
    const r = await composeNotification("notify.passenger.reminder", ctx, opts);
    expect(r.send && r.message.type === "text" && r.message.text).toMatch(/Reminder.*Carlos.*AB123CD/s);
    expect((await composeNotification("notify.passenger.reminder", { ...ctx, state: "cancelled" }, opts)).send).toBe(false);
    const rt = await composeNotification("notify.passenger.rating", { ...ctx, state: "closed" }, opts);
    expect(rt.send && rt.message.type === "list" && rt.message.rows.map((x) => x.id)).toEqual([5, 4, 3, 2, 1].map((n) => `rate:${ctx.bookingId}:${n}`));
  });
});

describe("WhatsApp assistant — free questions with the customer's memory", () => {
  const memory = {
    name: "Emma Wilson",
    bookings: [{ reference: "STT-AB12CD", state: "confirmed", direction: "from_airport" as const, airport: "EZE", zone: "Palermo",
      pickupPlace: null, dropoffPlace: "Hotel Palermo", pickupAt: "2026-11-28T15:00:00Z", proposedPickupAt: null,
      flight: "AR1303", flightStatus: "Delayed", flightEstimatedArrivalAt: "2026-11-28T15:40:00Z",
      passengers: 2, largeBags: 2, carryOn: 1, vehicleClass: "sedan_premium", amountMinor: 5000000, currency: "ARS",
      paymentMode: "pay_on_pickup_cash", paid: false, cancelledReason: null,
      driver: { firstName: "Carlos", vehicle: "Toyota Corolla", plate: "AB123CD", stage: "en_route" }, rating: null }],
    messages: [{ at: "2026-11-27T20:00:00Z", from: "customer" as const, text: "¿Tienen silla de bebé?" }],
    calls: [{ at: "2026-11-27T21:00:00Z", status: "ended", durationS: 180, handledBy: "Sofía (bot)", transferred: false,
      note: "Pide silla de bebé", callbackPending: true, booking: "STT-AB12CD", transcript: "Cliente: ¿tienen silla de bebé?" }],
  };
  let seen: { text: string; awaiting: string; customer: any; facts: any }[];
  const assistant = (r: Awaited<ReturnType<NonNullable<EngineDeps["assistant"]>["reply"]>>) => ({
    async reply(i: any) { seen.push(i); return r; },
  });
  beforeEach(() => { seen = []; deps.customerContext = async () => memory; });

  it("answers a ride question from the memory (driver, car, flight) in local time", async () => {
    deps.assistant = assistant({ action: "answer", reply: "Tu chofer es Carlos, en un Toyota Corolla AB123CD, y ya está en camino 🚗" });
    expect(all(await send("quien me viene a buscar y en que auto"))).toMatch(/Carlos.*AB123CD/);
    const c = seen[0].customer;
    expect(c.bookings[0]).toMatchObject({ reference: "STT-AB12CD", status: "confirmada", driver: { name: "Carlos", plate: "AB123CD", status: "en camino" } });
    expect(c.bookings[0].flight.estimatedArrival).toMatch(/12:40/);          // 15:40 UTC → 12:40 Buenos Aires
    expect(c.previousCalls[0]).toMatchObject({ note: "Pide silla de bebé", callbackPending: true });
    expect(c.recentWhatsApp[0]).toMatch(/silla de bebé/);
    expect(seen[0].facts.rules.freeCancellationHoursBefore).toBeDefined();
    expect(seen[0].awaiting).toBe("none");
  });

  it("routes intents to the safe flows: cancel → terms buttons, staff → hand-off, book → guided booking, bookings → list", async () => {
    deps.cancelBooking = async () => ({ allowed: true, reason: null, refundPercent: 100, freeUntilHoursBefore: 24, freeUntil: NOW.toISOString(),
      paidMinor: 0, refundMinor: 0, currency: "ARS", reference: "STT-AB12CD", pickupAt: "2026-11-29T15:00:00Z", paymentMode: "pay_on_pickup_cash" });
    deps.assistant = assistant({ action: "cancel", reply: "", reference: "STT-AB12CD" });
    expect(ids(await send("necesito cancelar el viaje de mañana"))).toEqual(["bk:cancelok:STT-AB12CD", "bk:keep:STT-AB12CD"]);

    deps.assistant = assistant({ action: "staff", reply: "Te paso con una persona para cambiar la hora." });
    await send("quiero cambiar la hora del viaje");
    expect(last().needsStaff).toBe(true);
    expect(conv.step).toBe("handoff");

    conv = { ...conv, step: "done", draft: {} };
    deps.assistant = assistant({ action: "book", reply: "¡Dale! Armemos tu viaje." });
    const r = await send("me cotizan un viaje");
    expect(all(r)).toContain("Armemos tu viaje");
    expect(ids(r)).toContain("dir:from_airport");
  });

  it("a new trip written in one message keeps its details after the AI routes it", async () => {
    deps.assistant = assistant({ action: "book", reply: "" });
    await send("necesito un taxi desde ezeiza a palermo, somos 2");
    expect(conv.draft).toMatchObject({ direction: "from_airport", airport: "EZE", zoneCode: "palermo", passengers: 2 });
  });

  it("answers a question in the middle of a booking and repeats the pending question", async () => {
    deps.assistant = assistant({ action: "answer", reply: "Sí, en el sedán entran 3 valijas grandes." });
    await send({ reply: "menu:book" });
    await send({ reply: "dir:from_airport" });
    const r = await send("¿cuántas valijas entran en el auto?");
    expect(all(r)).toContain("entran 3 valijas");
    expect(ids(r)).toEqual(["ap:EZE", "ap:AEP"]);                     // same question again
    expect(seen[0].awaiting).toBe("airport");
    expect(conv.draft.direction).toBe("from_airport");               // nothing lost
  });

  it("falls back to the menu when the AI can't help; greetings still show the menu", async () => {
    deps.assistant = assistant(null);
    expect(ids(await send("bla bla bla"))).toContain("menu:book");
    deps.assistant = assistant({ action: "answer", reply: "x" });
    expect(ids(await send("hola"))).toContain("menu:book");
    expect(seen.length).toBe(1);                                        // "hola" never reached the AI
  });

  it("parses the model's JSON safely", async () => {
    const { makeAssistant, assistantPrompt } = await import("@shared/whatsapp/ai.ts");
    const fake = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as unknown as typeof fetch;
    const input = { text: "hola", locale: "es-AR" as const, awaiting: "none", facts: { operator: "X" }, customer: { name: "Emma" } };
    expect(await makeAssistant({ apiKey: "k" }, fake('{"action":"cancel","reply":"ok","reference":"stt-ab12cd","language":"es"}')).reply(input))
      .toEqual({ action: "cancel", reply: "ok", reference: "STT-AB12CD", language: "es" });
    expect(await makeAssistant({ apiKey: "k" }, fake('{"action":"delete_everything","reply":"x"}')).reply(input)).toBeNull();
    expect(await makeAssistant({ apiKey: "k" }, fake("not json")).reply(input)).toBeNull();
    expect(await makeAssistant({ apiKey: "k" }, fake('{"action":"answer","reply":""}')).reply(input)).toBeNull();
    expect(assistantPrompt(input)).toContain('"name":"Emma"');
    expect(assistantPrompt({ ...input, awaiting: "passengers" })).toContain("waiting for: passengers");
  });

  it("recognises questions", async () => {
    const { looksLikeQuestion } = await import("@shared/whatsapp/engine.ts");
    expect(looksLikeQuestion("¿aceptan tarjeta?")).toBe(true);
    expect(looksLikeQuestion("donde me espera el chofer")).toBe(true);
    expect(looksLikeQuestion("do you have child seats")).toBe(true);
    expect(looksLikeQuestion("Av. Corrientes 1234")).toBe(false);
    expect(looksLikeQuestion("3")).toBe(false);
  });
});
