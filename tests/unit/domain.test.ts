import { describe, expect, it } from "vitest";
import { eligibilityReasons } from "@shared/domain/capacity.ts";
import { matchFare } from "@shared/domain/fare.ts";
import { DEMO_AIRPORTS, DEMO_VEHICLE_CLASSES, DEMO_ZONES, demoOperatorConfig } from "@shared/domain/fixtures.ts";
import { pointInZone } from "@shared/domain/geo.ts";
import { computeQuote, normalizeFlight } from "@shared/domain/quote.ts";
import { localToUtc, utcToLocalDate, utcToLocalTime } from "@shared/domain/time.ts";
import type { FareRule, JourneyInput } from "@shared/domain/types.ts";

const NOW = new Date("2026-11-26T15:00:00Z"); // 12:00 in Buenos Aires
const cfg = demoOperatorConfig();
const sedan = DEMO_VEHICLE_CLASSES.find((v) => v.code === "sedan_premium")!;
const minivan = DEMO_VEHICLE_CLASSES.find((v) => v.code === "minivan")!;

function journey(over: Partial<JourneyInput> = {}): JourneyInput {
  return {
    direction: "from_airport", airport: "EZE", zoneCode: "palermo", place: { text: "Honduras 5600" },
    date: "2026-11-28", time: "08:00", flightDesignator: "AR1303",
    passengers: 2, largeBags: 2, carryOn: 1, locale: "es-AR", ...over,
  };
}

describe("time (America/Argentina/Buenos_Aires)", () => {
  it("converts local wall clock to UTC (UTC-3)", () => {
    expect(localToUtc("2026-11-28", "08:00").toISOString()).toBe("2026-11-28T11:00:00.000Z");
  });
  it("handles after-midnight local times on the correct local date", () => {
    const d = localToUtc("2026-11-29", "00:30");
    expect(d.toISOString()).toBe("2026-11-29T03:30:00.000Z");
    expect(utcToLocalDate(d)).toBe("2026-11-29");
    expect(utcToLocalTime(d)).toBe("00:30");
  });
  it("local date of a late UTC instant is the previous day in BA", () => {
    expect(utcToLocalDate(new Date("2026-11-29T02:00:00Z"))).toBe("2026-11-28");
  });
});

describe("vehicle eligibility", () => {
  it("sedan fails four people with four large cases; minivan fits", () => {
    const load = { passengers: 4, largeBags: 4, carryOn: 0 };
    expect(eligibilityReasons(sedan, load)).toContain("too_many_large_bags");
    expect(eligibilityReasons(minivan, load)).toEqual([]);
  });
  it("applies seat limits", () => {
    expect(eligibilityReasons(minivan, { passengers: 5, largeBags: 0, carryOn: 0 })).toEqual(["too_many_passengers"]);
  });
  it("applies the joint bag-unit rule independently of the per-type limits", () => {
    const tight = { ...sedan, maxBagUnits: 5 };
    // 2 large (4 units) + 2 carry-on (2 units) = 6 > 5, though each per-type limit is met
    expect(eligibilityReasons(tight, { passengers: 1, largeBags: 2, carryOn: 2 })).toEqual(["combined_baggage_exceeded"]);
  });
});

describe("fare matching", () => {
  const eze = DEMO_AIRPORTS[0].id;
  const palermo = DEMO_ZONES[0].id;
  const base: FareRule = {
    id: "r1", direction: "from_airport", airportId: eze, zoneId: null, vehicleClass: "sedan_premium", rank: 100,
    amountMinor: 3000, taxesMinor: 0, currency: "USD", estDurationMin: 55, effectiveFrom: "2026-01-01", effectiveTo: null,
    version: 1, active: true, isDemo: true,
  };
  const query = { direction: "from_airport" as const, airportId: eze, zoneId: palermo, vehicleClass: "sedan_premium", pickupLocalDate: "2026-11-28" };

  it("prefers a zone-specific rule over a generic one at equal rank", () => {
    const m = matchFare([base, { ...base, id: "r2", zoneId: palermo, amountMinor: 3500 }], query);
    expect(m.ok && m.rule.id).toBe("r2");
  });
  it("prefers lower rank over specificity", () => {
    const m = matchFare([{ ...base, rank: 10 }, { ...base, id: "r2", zoneId: palermo }], query);
    expect(m.ok && m.rule.id).toBe("r1");
  });
  it("rejects ambiguous rules (same rank, same specificity)", () => {
    const m = matchFare([base, { ...base, id: "r2", amountMinor: 3100 }], query);
    expect(m).toMatchObject({ ok: false, reason: "ambiguous_fare_rules" });
  });
  it("respects effective date ranges (end exclusive)", () => {
    const m = matchFare([{ ...base, effectiveTo: "2026-11-28" }], query);
    expect(m).toMatchObject({ ok: false, reason: "no_fare_rule" });
  });
  it("is direction-specific", () => {
    const m = matchFare([base], { ...query, direction: "to_airport" });
    expect(m.ok).toBe(false);
  });
});

describe("computeQuote", () => {
  it("prices EZE→Palermo sedan at the site's USD 30 example and adds the arrival buffer", () => {
    const r = computeQuote(journey(), cfg, { now: NOW });
    expect(r.kind).toBe("priced");
    if (r.kind !== "priced") return;
    expect(r.vehicleClass).toBe("sedan_premium");
    expect(r.fare).toMatchObject({ totalMinor: 3000, currency: "USD", isDemo: true });
    expect(r.journey.pickupLocalTime).toBe("09:00"); // 08:00 arrival + 60 min EZE buffer
    expect(r.journey.flight).toMatchObject({ designator: "AR1303", localArrivalDate: "2026-11-28" });
    expect(r.journey.pickup.kind).toBe("airport");
    expect(r.journey.dropoff.originalText).toBe("Honduras 5600");
  });

  it("acceptance: 4 people + 4 large cases → sedan ineligible, minivan offered", () => {
    const r = computeQuote(journey({ passengers: 4, largeBags: 4, carryOn: 0 }), cfg, { now: NOW });
    expect(r.kind).toBe("priced");
    if (r.kind !== "priced") return;
    expect(r.vehicleClass).toBe("minivan");
    const s = r.options.find((o) => o.code === "sedan_premium")!;
    expect(s.eligible).toBe(false);
    expect(s.reasons).toContain("too_many_large_bags");
    expect(r.fare.totalMinor).toBe(4500);
  });

  it("rejects an explicitly requested ineligible class", () => {
    const r = computeQuote(journey({ passengers: 4, largeBags: 4, vehicleClass: "sedan_premium" }), cfg, { now: NOW });
    expect(r).toMatchObject({ kind: "invalid", errors: [{ field: "vehicleClass", code: "vehicle_not_eligible" }] });
  });

  it("requires a flight for airport pickups (unless staff exception)", () => {
    const r = computeQuote(journey({ flightDesignator: null }), cfg, { now: NOW });
    expect(r.kind).toBe("invalid");
    const staff = computeQuote(journey({ flightDesignator: null }), cfg, { now: NOW, allowMissingFlight: true });
    expect(staff.kind).toBe("priced");
  });

  it("normalises flight designators", () => {
    expect(normalizeFlight("ar 1303")).toBe("AR1303");
    expect(computeQuote(journey({ flightDesignator: "la-4521" }), cfg, { now: NOW }).kind).toBe("priced");
    expect(computeQuote(journey({ flightDesignator: "not a flight" }), cfg, { now: NOW })).toMatchObject({ kind: "invalid" });
  });

  it("enforces lead time and past times", () => {
    const soon = computeQuote(journey({ direction: "to_airport", flightDesignator: null, date: "2026-11-26", time: "13:30" }), cfg, { now: NOW });
    expect(soon).toMatchObject({ kind: "invalid", errors: [{ field: "time", code: "inside_lead_time" }] });
    const past = computeQuote(journey({ direction: "to_airport", flightDesignator: null, date: "2026-11-26", time: "09:00" }), cfg, { now: NOW });
    expect(past).toMatchObject({ kind: "invalid", errors: [{ field: "time", code: "in_past" }] });
  });

  it("rejects impossible dates as a question rather than guessing", () => {
    expect(computeQuote(journey({ date: "2026-02-30" }), cfg, { now: NOW })).toMatchObject({
      kind: "invalid", errors: [{ field: "date", code: "invalid_date" }],
    });
  });

  it("uses direction-specific reverse fares (city→EZE sedan is not the USD 30 example)", () => {
    const r = computeQuote(journey({ direction: "to_airport", flightDesignator: null }), cfg, { now: NOW });
    expect(r.kind === "priced" && r.fare.totalMinor).toBe(3200);
    if (r.kind === "priced") {
      expect(r.journey.pickupLocalTime).toBe("08:00"); // no arrival buffer for trips to the airport
      expect(r.journey.dropoff.kind).toBe("airport");
    }
  });

  it("falls back to a manual quote for unpriced routes", () => {
    const tigre = computeQuote(journey({ zoneCode: "tigre" }), cfg, { now: NOW });
    expect(tigre).toMatchObject({ kind: "manual", reasons: ["no_fare_rule"] });
    const bus = computeQuote(journey({ direction: "to_airport", flightDesignator: null, passengers: 10, largeBags: 10, carryOn: 0 }), cfg, { now: NOW });
    expect(bus).toMatchObject({ kind: "manual", vehicleClass: "taxibus" });
  });

  it("manual quote when no vehicle class fits", () => {
    const r = computeQuote(journey({ passengers: 20 }), cfg, { now: NOW });
    expect(r).toMatchObject({ kind: "manual", reasons: ["no_vehicle_fits"] });
  });

  it("unknown zone / airport are validation errors", () => {
    const r = computeQuote(journey({ zoneCode: "mar_del_plata", airport: "COR" }), cfg, { now: NOW });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.errors.map((e) => e.field).sort()).toEqual(["airport", "zoneCode"]);
  });

  it("verifies optional coordinates against the chosen zone", () => {
    const inPalermo = { lat: -34.58, lng: -58.43 };
    expect(pointInZone(inPalermo.lng, inPalermo.lat, DEMO_ZONES[0])).toBe(true);
    const ok = computeQuote(journey({ place: { text: "Honduras 5600", ...inPalermo } }), cfg, { now: NOW });
    expect(ok.kind === "priced" && ok.journey.dropoff.verified).toBe(true);

    const recoletaPin = computeQuote(journey({ place: { text: "Honduras 5600", lat: -34.59, lng: -58.39 } }), cfg, { now: NOW });
    expect(recoletaPin).toMatchObject({ kind: "invalid", errors: [{ field: "place.coordinates", code: "location_zone_mismatch" }] });

    const sea = computeQuote(journey({ place: { text: "Río de la Plata", lat: -34.5, lng: -58.2 } }), cfg, { now: NOW });
    expect(sea).toMatchObject({ kind: "invalid", errors: [{ field: "place.coordinates", code: "outside_service_area" }] });
  });

  it("after-midnight arrival keeps the flight's local arrival date and shifts pickup into the next day correctly", () => {
    const r = computeQuote(journey({ date: "2026-11-28", time: "23:30" }), cfg, { now: NOW });
    expect(r.kind).toBe("priced");
    if (r.kind !== "priced") return;
    expect(r.journey.flight?.localArrivalDate).toBe("2026-11-28");
    expect(r.journey.pickupLocalDate).toBe("2026-11-29");
    expect(r.journey.pickupLocalTime).toBe("00:30");
  });
});
