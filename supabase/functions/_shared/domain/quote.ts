import { eligibilityReasons, orderedClasses } from "./capacity.ts";
import { matchFare } from "./fare.ts";
import { isValidLatLng, pointInZone, zonesContaining } from "./geo.ts";
import {
  addDaysLocal, addMinutes, isValidLocalDate, isValidLocalTime, localToUtc, utcToLocalDate, utcToLocalTime,
} from "./time.ts";
import type {
  FieldError, JourneyInput, NormalizedJourney, OperatorConfig, Place, QuoteComputation, VehicleOption,
} from "./types.ts";

export const FLIGHT_RE = /^[A-Z0-9]{2}[A-Z]?[0-9]{1,4}[A-Z]?$/;

/** "ar 1303" / "AR-1303" → "AR1303". */
export function normalizeFlight(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

export interface QuoteOptions {
  now: Date;
  /** Staff may record an airport pickup without a flight (requires a reason at booking time). */
  allowMissingFlight?: boolean;
}

const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);

/**
 * Validate a journey request against operator configuration and compute the server-side fare.
 * Pure function: same input + config + clock → same result.
 */
export function computeQuote(input: JourneyInput, cfg: OperatorConfig, opts: QuoteOptions): QuoteComputation {
  const errors: FieldError[] = [];
  const pol = cfg.policy.config;
  const tz = cfg.timezone;

  // --- shape ---------------------------------------------------------------
  if (input.direction !== "from_airport" && input.direction !== "to_airport") errors.push({ field: "direction", code: "invalid" });
  const airport = cfg.airports.find((a) => a.active && a.iata === String(input.airport ?? "").toUpperCase());
  if (!airport) errors.push({ field: "airport", code: "unsupported_airport" });
  const zone = cfg.zones.find((z) => z.active && z.code === input.zoneCode);
  if (!zone) errors.push({ field: "zoneCode", code: "outside_service_area" });

  const text = String(input.place?.text ?? "").trim();
  if (text.length < 3) errors.push({ field: "place.text", code: "required" });
  if (text.length > 300) errors.push({ field: "place.text", code: "too_long" });

  for (const [f, max] of [["passengers", 60], ["largeBags", 60], ["carryOn", 60]] as const) {
    const v = input[f];
    if (!int(v) || v < (f === "passengers" ? 1 : 0) || v > max) errors.push({ field: f, code: "invalid_count" });
  }

  if (!isValidLocalDate(input.date)) errors.push({ field: "date", code: "invalid_date" });
  if (!isValidLocalTime(input.time)) errors.push({ field: "time", code: "invalid_time" });

  let flight: string | null = null;
  if (input.flightDesignator) {
    flight = normalizeFlight(input.flightDesignator);
    if (!FLIGHT_RE.test(flight)) errors.push({ field: "flightDesignator", code: "invalid_flight" });
  } else if (input.direction === "from_airport" && !opts.allowMissingFlight) {
    errors.push({ field: "flightDesignator", code: "required" });
  }

  // --- optional coordinates must agree with the chosen zone --------------------
  let verified = false;
  const lat = input.place?.lat ?? null;
  const lng = input.place?.lng ?? null;
  if (lat !== null || lng !== null) {
    if (!isValidLatLng(lat, lng)) {
      errors.push({ field: "place.coordinates", code: "invalid_coordinates" });
    } else if (zone) {
      if (pointInZone(lng as number, lat, zone)) {
        verified = true;
      } else {
        const actual = zonesContaining(lng as number, lat, cfg.zones);
        errors.push({ field: "place.coordinates", code: actual.length ? "location_zone_mismatch" : "outside_service_area" });
      }
    }
  }

  if (errors.length || !airport || !zone) return { kind: "invalid", errors };

  // --- timeline --------------------------------------------------------------
  let pickupAt: Date;
  let flightInfo: NormalizedJourney["flight"] = null;
  if (input.direction === "from_airport") {
    const arrival = localToUtc(input.date, input.time, tz);
    const buffer = pol.arrival_buffer_minutes[airport.iata] ?? 45;
    pickupAt = addMinutes(arrival, buffer);
    if (flight) {
      flightInfo = {
        designator: flight, localArrivalDate: input.date, scheduledArrivalAt: arrival.toISOString(),
        scheduledArrivalLocal: input.time, bufferMinutes: buffer,
      };
    }
  } else {
    pickupAt = localToUtc(input.date, input.time, tz);
  }

  const earliest = addMinutes(opts.now, pol.lead_time_minutes);
  if (pickupAt < earliest) errors.push({ field: "time", code: pickupAt < opts.now ? "in_past" : "inside_lead_time" });
  const latestDate = addDaysLocal(utcToLocalDate(opts.now, tz), pol.max_advance_days);
  if (input.date > latestDate) errors.push({ field: "date", code: "too_far_ahead" });
  if (errors.length) return { kind: "invalid", errors };

  const cityPlace: Place = {
    label: text, originalText: String(input.place.text), lat, lng, verified, zoneCode: zone.code, kind: "address",
  };
  const airportPlace: Place = {
    label: `${airport.name} (${airport.iata})`, originalText: airport.iata, lat: airport.lat, lng: airport.lng,
    verified: true, zoneCode: null, kind: "airport",
  };

  const journey: NormalizedJourney = {
    direction: input.direction,
    airportIata: airport.iata,
    airportId: airport.id,
    zoneId: zone.id,
    zoneCode: zone.code,
    pickup: input.direction === "from_airport" ? airportPlace : cityPlace,
    dropoff: input.direction === "from_airport" ? cityPlace : airportPlace,
    pickupAt: pickupAt.toISOString(),
    pickupLocalDate: utcToLocalDate(pickupAt, tz),
    pickupLocalTime: utcToLocalTime(pickupAt, tz),
    flight: flightInfo,
    passengers: input.passengers,
    largeBags: input.largeBags,
    carryOn: input.carryOn,
    locale: input.locale === "en" ? "en" : "es-AR",
  };

  // --- vehicle eligibility & price per class ---------------------------------
  const load = { passengers: input.passengers, largeBags: input.largeBags, carryOn: input.carryOn };
  const options: VehicleOption[] = orderedClasses(cfg.vehicleClasses).map((vc) => {
    const reasons = eligibilityReasons(vc, load);
    const match = matchFare(cfg.fareRules, {
      direction: input.direction, airportId: airport.id, zoneId: zone.id, vehicleClass: vc.code,
      pickupLocalDate: journey.pickupLocalDate,
    });
    return {
      code: vc.code,
      eligible: reasons.length === 0,
      reasons,
      amountMinor: match.ok ? match.fare.totalMinor : null,
      currency: match.ok ? match.fare.currency : null,
    };
  });

  let chosen: string | null = null;
  if (input.vehicleClass) {
    const opt = options.find((o) => o.code === input.vehicleClass);
    if (!opt) return { kind: "invalid", errors: [{ field: "vehicleClass", code: "unknown_vehicle_class" }], options };
    if (!opt.eligible) return { kind: "invalid", errors: [{ field: "vehicleClass", code: "vehicle_not_eligible" }], options };
    chosen = opt.code;
  } else {
    // Smallest eligible class that has a price; else smallest eligible class (manual quote).
    chosen = options.find((o) => o.eligible && o.amountMinor !== null)?.code
      ?? options.find((o) => o.eligible)?.code ?? null;
  }

  if (!chosen) return { kind: "manual", journey, vehicleClass: null, reasons: ["no_vehicle_fits"], options };

  const match = matchFare(cfg.fareRules, {
    direction: input.direction, airportId: airport.id, zoneId: zone.id, vehicleClass: chosen,
    pickupLocalDate: journey.pickupLocalDate,
  });
  if (!match.ok) return { kind: "manual", journey, vehicleClass: chosen, reasons: [match.reason], options };

  return { kind: "priced", journey, vehicleClass: chosen, fare: match.fare, options };
}
