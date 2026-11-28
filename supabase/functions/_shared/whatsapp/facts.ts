// Facts shared by the WhatsApp assistant and Sofía (voice): the operator's real rules, and what we know about
// the person on this number (bookings with live ride details, recent WhatsApp messages, previous calls).
// Times are pre-formatted in Buenos Aires time so the AI never has to convert UTC.
import { formatMoney } from "../domain/fare.ts";
import { utcToLocalDate } from "../domain/time.ts";
import type { Locale, OperatorConfig } from "../domain/types.ts";

export interface CustomerContext {
  name: string | null;
  bookings: {
    reference: string; state: string; direction: "from_airport" | "to_airport"; airport: string; zone: string | null;
    pickupPlace: string | null; dropoffPlace: string | null; pickupAt: string; proposedPickupAt: string | null;
    flight: string | null; flightStatus: string | null; flightEstimatedArrivalAt: string | null;
    passengers: number; largeBags: number; carryOn: number; vehicleClass: string;
    amountMinor: number | null; currency: string | null; paymentMode: string; paid: boolean; cancelledReason: string | null;
    driver: { firstName: string; vehicle: string | null; plate: string | null; stage: string } | null;
    rating: number | null;
  }[];
  messages: { at: string; from: "customer" | "bot" | "staff"; text: string }[];
  calls: { at: string; status: string; durationS: number | null; handledBy: string; transferred: boolean; note: string | null;
    callbackPending: boolean; booking: string | null; transcript: string | null }[];
}

export function localWhen(iso: string, tz: string, lc: Locale) {
  const l = lc === "en" ? "en-GB" : "es-AR";
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d)}, ${
    new Intl.DateTimeFormat(l, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
}

const STATE: Record<string, [string, string]> = {
  requested: ["recibida", "received"], needs_driver: ["buscando chofer", "looking for a driver"],
  held: ["chofer reservado, falta el pago", "driver reserved, waiting for payment"], confirmed: ["confirmada", "confirmed"],
  closed: ["viaje realizado", "trip completed"], cancelled: ["cancelada", "cancelled"],
};
const STAGE: Record<string, [string, string]> = {
  scheduled: ["todavía no salió", "not on the way yet"], en_route: ["en camino", "on the way"], at_pickup: ["ya llegó al punto de encuentro", "has arrived at the pickup point"],
  onboard: ["viaje en curso", "trip in progress"], complete: ["viaje terminado", "trip finished"], no_show: ["marcado como pasajero no presentado", "marked as no-show"],
};
const PAY: Record<string, [string, string]> = {
  prepaid: ["prepago online", "prepaid online"], pay_on_pickup_cash: ["efectivo al chofer", "cash to the driver"],
  pay_on_pickup_card: ["tarjeta al chofer", "card to the driver"], account: ["a cuenta de su hotel/agencia", "billed to their hotel/agency"],
};

/** Operator facts (no customer data). */
export function operatorFacts(cfg: OperatorConfig, now: Date) {
  const pc = cfg.policy.config;
  return {
    operator: cfg.name, demo: cfg.demoMode || cfg.policy.isDemo,
    now: localWhen(now.toISOString(), cfg.timezone, "es-AR"), today: utcToLocalDate(now, cfg.timezone),
    airports: cfg.airports.filter((a) => a.active).map((a) => ({ code: a.iata, name: a.name, meetingPointEs: a.meetingPointEs, meetingPointEn: a.meetingPointEn })),
    zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name })),
    vehicles: cfg.vehicleClasses.filter((v) => v.active).map((v) => ({ code: v.code, es: v.labelEs, en: v.labelEn,
      maxPassengers: v.maxPassengers, maxLargeBags: v.maxLargeBags, maxCarryOn: v.maxCarryOn })),
    rules: {
      leadTimeHours: Math.round(pc.lead_time_minutes / 60), maxAdvanceDays: pc.max_advance_days,
      freeCancellationHoursBefore: pc.cancellation.free_until_hours_before, refundPercentAfter: pc.cancellation.refund_percent_after,
      freeWaitAirportMinutes: pc.waiting.free_wait_minutes_airport, freeWaitCityMinutes: pc.waiting.free_wait_minutes_city,
      arrivalPickupBufferMinutes: pc.arrival_buffer_minutes, paymentModes: pc.allowed_payment_modes, flightTracked: true,
    },
  };
}

/** The customer's memory, readable by a language model: local times, plain-language states, no internal ids. */
export function customerFacts(c: CustomerContext | null, cfg: OperatorConfig, lc: Locale) {
  if (!c) return null;
  const en = lc === "en" ? 1 : 0;
  const w = (iso: string | null) => (iso ? localWhen(iso, cfg.timezone, lc) : null);
  return {
    name: c.name,
    bookings: c.bookings.map((b) => ({
      reference: b.reference, status: (STATE[b.state] ?? [b.state, b.state])[en],
      route: b.direction === "from_airport" ? `${b.airport} → ${b.dropoffPlace ?? b.zone ?? ""}` : `${b.pickupPlace ?? b.zone ?? ""} → ${b.airport}`,
      pickup: w(b.pickupAt), proposedNewPickup: w(b.proposedPickupAt),
      flight: b.flight ? { number: b.flight, status: b.flightStatus, estimatedArrival: w(b.flightEstimatedArrivalAt) } : null,
      party: `${b.passengers} pax, ${b.largeBags} large bags, ${b.carryOn} carry-on`, vehicle: b.vehicleClass,
      price: b.amountMinor != null && b.currency ? formatMoney(b.amountMinor, b.currency, lc) : null,
      payment: (PAY[b.paymentMode] ?? [b.paymentMode, b.paymentMode])[en] + (b.paid ? (en ? " (paid)" : " (pagado)") : ""),
      driver: b.driver ? { name: b.driver.firstName, car: b.driver.vehicle, plate: b.driver.plate, status: (STAGE[b.driver.stage] ?? [b.driver.stage, b.driver.stage])[en] } : null,
      cancelledReason: b.cancelledReason, rating: b.rating,
    })),
    recentWhatsApp: c.messages.map((m) => `${w(m.at)} · ${m.from}: ${m.text}`),
    previousCalls: c.calls.map((k) => ({
      when: w(k.at), answeredBy: k.handledBy, transferredToStaff: k.transferred, minutes: k.durationS ? Math.round(k.durationS / 60) : null,
      note: k.note, callbackPending: k.callbackPending, booking: k.booking, transcriptEnd: k.transcript,
    })),
  };
}
