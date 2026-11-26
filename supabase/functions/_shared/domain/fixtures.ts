// DEMO FIXTURES — clearly labelled example values. Live rates and policies must be entered by an
// admin before production. `scripts/gen-seed.ts` turns this file into supabase/seed.sql so the demo
// backend and the database seed never drift apart.
//
// Vehicle capacities follow soytutaxi.com/booking (Sedan Premium 4 pax / 2 suitcases / 2 carry-on,
// Minivan 4 pax / 6 suitcases, TaxiBus 15 pax / 15 suitcases). Confirm combined baggage rules with
// SoyTuTaxi. Carry-on limits for Minivan/TaxiBus and all bag-unit limits are assumptions.
// Fares: the site's USD 30 (EZE) and USD 20 (AEP) are airport→city Sedan examples. Every other fare
// below is an invented demo value.

import type {
  Airport, Direction, Driver, FareRule, OperatorConfig, PaymentMode, Policy, Vehicle, VehicleClass, Zone,
} from "./types.ts";

export const DEMO_OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

export const DEMO_VEHICLE_CLASSES: VehicleClass[] = [
  { code: "sedan_premium", labelEs: "Sedán Premium", labelEn: "Sedan Premium", maxPassengers: 4, maxLargeBags: 2, maxCarryOn: 2, maxBagUnits: 6, sortOrder: 10, active: true },
  { code: "minivan", labelEs: "Minivan", labelEn: "Minivan", maxPassengers: 4, maxLargeBags: 6, maxCarryOn: 4, maxBagUnits: 16, sortOrder: 20, active: true },
  { code: "taxibus", labelEs: "TaxiBus", labelEn: "TaxiBus", maxPassengers: 15, maxLargeBags: 15, maxCarryOn: 15, maxBagUnits: 45, sortOrder: 30, active: true },
];

export const DEMO_AIRPORTS: Airport[] = [
  {
    id: "a1111111-0000-4000-8000-0000000000e1", iata: "EZE", name: "Aeropuerto Internacional Ezeiza",
    meetingPointEs: "Hall de arribos, Terminal A — frente a la salida de Aduana. El chofer espera con un cartel con su nombre.",
    meetingPointEn: "Arrivals hall, Terminal A — opposite the customs exit. Your driver holds a sign with your name.",
    lat: -34.8222, lng: -58.5358, active: true,
  },
  {
    id: "a1111111-0000-4000-8000-0000000000a1", iata: "AEP", name: "Aeroparque Jorge Newbery",
    meetingPointEs: "Hall central de arribos, junto al punto de encuentro señalizado.",
    meetingPointEn: "Main arrivals hall, beside the signed meeting point.",
    lat: -34.5592, lng: -58.4156, active: true,
  },
];

const box = (w: number, s: number, e: number, n: number): [number, number][] => [[w, s], [e, s], [e, n], [w, n], [w, s]];

export const DEMO_ZONES: Zone[] = [
  { id: "b2222222-0000-4000-8000-000000000001", code: "palermo", name: "Palermo", polygon: [box(-58.445, -34.595, -58.400, -34.560)], active: true },
  { id: "b2222222-0000-4000-8000-000000000002", code: "recoleta", name: "Recoleta", polygon: [box(-58.400, -34.600, -58.380, -34.580)], active: true },
  { id: "b2222222-0000-4000-8000-000000000003", code: "microcentro", name: "Microcentro / Retiro", polygon: [box(-58.380, -34.612, -58.367, -34.590)], active: true },
  { id: "b2222222-0000-4000-8000-000000000004", code: "puerto_madero", name: "Puerto Madero", polygon: [box(-58.367, -34.625, -58.355, -34.595)], active: true },
  { id: "b2222222-0000-4000-8000-000000000005", code: "belgrano", name: "Belgrano", polygon: [box(-58.470, -34.575, -58.445, -34.545)], active: true },
  // Served zone with no fare rules → every Tigre journey needs a manual quote (demo of that path).
  { id: "b2222222-0000-4000-8000-000000000006", code: "tigre", name: "Tigre (cotización manual)", polygon: [box(-58.600, -34.440, -58.550, -34.400)], active: true },
];

export const DEMO_POLICY: Policy = {
  id: "c3333333-0000-4000-8000-000000000001",
  version: 1,
  label: "DEMO policy v1 — replace before production",
  isDemo: true,
  config: {
    quote_expiry_minutes: 30,
    lead_time_minutes: 180,
    max_advance_days: 180,
    hold_minutes: 15,
    offer_expiry_minutes: 10,
    auto_offer_group_size: 3,
    turnaround_minutes: 20,
    arrival_buffer_minutes: { EZE: 60, AEP: 30 },
    allowed_payment_modes: ["prepaid", "pay_on_pickup_cash"],
    waiting: { free_wait_minutes_airport: 60, free_wait_minutes_city: 15, no_show_after_minutes: 90 },
    cancellation: { free_until_hours_before: 24, refund_percent_after: 50 },
    flight_monitoring: { start_hours_before: 24, interval_minutes: 15, change_threshold_minutes: 15, taxi_to_gate_minutes: 10 },
    escalation: { unassigned_alert_hours_before: 12, paid_without_cover_alert_minutes: 30 },
  },
};

// --- fares -------------------------------------------------------------------
const CITY_ZONES = ["palermo", "recoleta", "microcentro", "puerto_madero", "belgrano"] as const;
type Priced = Partial<Record<string, number>>;
const FARES: Record<Direction, Record<"EZE" | "AEP", Priced>> = {
  // Site examples: EZE→city Sedan USD 30, AEP→city Sedan USD 20.
  from_airport: { EZE: { sedan_premium: 3000, minivan: 4500, taxibus: 12000 }, AEP: { sedan_premium: 2000, minivan: 3200, taxibus: 9000 } },
  // Reverse direction has its own (demo) rules; EZE TaxiBus city→airport is deliberately unpriced.
  to_airport: { EZE: { sedan_premium: 3200, minivan: 4800 }, AEP: { sedan_premium: 2200, minivan: 3400, taxibus: 9500 } },
};
const DURATION: Record<"EZE" | "AEP", number> = { EZE: 55, AEP: 25 };

function hexId(n: number): string {
  return `d4444444-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const DEMO_FARE_RULES: FareRule[] = (() => {
  const out: FareRule[] = [];
  let n = 1;
  for (const direction of ["from_airport", "to_airport"] as Direction[]) {
    for (const iata of ["EZE", "AEP"] as const) {
      const airport = DEMO_AIRPORTS.find((a) => a.iata === iata)!;
      for (const zoneCode of CITY_ZONES) {
        const zone = DEMO_ZONES.find((z) => z.code === zoneCode)!;
        for (const [vehicleClass, amount] of Object.entries(FARES[direction][iata])) {
          out.push({
            id: hexId(n++), direction, airportId: airport.id, zoneId: zone.id, vehicleClass, rank: 100,
            amountMinor: amount!, taxesMinor: 0, currency: "USD", estDurationMin: DURATION[iata],
            effectiveFrom: "2026-01-01", effectiveTo: null, version: 1, active: true, isDemo: true,
          });
        }
      }
    }
  }
  return out;
})();

export const DEMO_VEHICLES: Vehicle[] = [
  { id: "e5555555-0000-4000-8000-000000000001", vehicleClass: "sedan_premium", plate: "AF 123 BC", description: "Toyota Corolla (demo)", active: true },
  { id: "e5555555-0000-4000-8000-000000000002", vehicleClass: "sedan_premium", plate: "AG 456 DE", description: "VW Vento (demo)", active: true },
  { id: "e5555555-0000-4000-8000-000000000003", vehicleClass: "sedan_premium", plate: "AH 789 FG", description: "Chevrolet Cruze (demo)", active: true },
  { id: "e5555555-0000-4000-8000-000000000004", vehicleClass: "minivan", plate: "AD 321 HJ", description: "Chevrolet Spin (demo)", active: true },
  { id: "e5555555-0000-4000-8000-000000000005", vehicleClass: "minivan", plate: "AE 654 KL", description: "Citroën Berlingo (demo)", active: true },
  { id: "e5555555-0000-4000-8000-000000000006", vehicleClass: "taxibus", plate: "AC 987 MN", description: "Mercedes Sprinter 15 (demo)", active: true },
];

export const DEMO_DRIVERS: Driver[] = [
  { id: "f6666666-0000-4000-8000-000000000001", fullName: "Martín Gómez", whatsappE164: "+5491100000001", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[0].id },
  { id: "f6666666-0000-4000-8000-000000000002", fullName: "Lucía Fernández", whatsappE164: "+5491100000002", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[3].id },
  { id: "f6666666-0000-4000-8000-000000000003", fullName: "Diego Romero", whatsappE164: "+5491100000003", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[1].id },
  { id: "f6666666-0000-4000-8000-000000000004", fullName: "Sofía Acosta", whatsappE164: "+5491100000004", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[4].id },
  { id: "f6666666-0000-4000-8000-000000000005", fullName: "Javier Benítez", whatsappE164: "+5491100000005", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[2].id },
  { id: "f6666666-0000-4000-8000-000000000006", fullName: "Carla Medina", whatsappE164: "+5491100000006", approvalStatus: "approved", active: true, vehicleId: DEMO_VEHICLES[5].id },
  { id: "f6666666-0000-4000-8000-000000000007", fullName: "Pablo Herrera", whatsappE164: "+5491100000007", approvalStatus: "pending", active: true, vehicleId: null },
];

// Staff users for local/staging seeding (auth.users rows are created by the seed in local dev only).
export const DEMO_STAFF = [
  { userId: "99999999-0000-4000-8000-000000000001", email: "admin@demo.soytutaxi.test", role: "admin" as const },
  { userId: "99999999-0000-4000-8000-000000000002", email: "despacho@demo.soytutaxi.test", role: "dispatcher" as const },
  { userId: "99999999-0000-4000-8000-000000000003", email: "finanzas@demo.soytutaxi.test", role: "finance" as const },
];

/** Example bookings relative to "today" in Buenos Aires, so the dispatch schedule is never empty. */
export interface DemoBooking {
  reference: string;
  dayOffset: number;
  direction: Direction;
  airport: "EZE" | "AEP";
  zoneCode: string;
  placeText: string;
  /** from_airport: scheduled arrival; to_airport: pickup time (local HH:mm). */
  time: string;
  flight: string | null;
  passengers: number;
  largeBags: number;
  carryOn: number;
  vehicleClass: string;
  paymentMode: PaymentMode;
  passenger: { name: string; phone: string; locale: "es-AR" | "en" };
  state: "needs_driver" | "held" | "confirmed" | "cancelled";
  driverIndex?: number;
  notes?: string;
}

export const DEMO_BOOKINGS: DemoBooking[] = [
  { reference: "STT-DEM001", dayOffset: 1, direction: "from_airport", airport: "EZE", zoneCode: "palermo", placeText: "Honduras 5600, Palermo Soho", time: "06:40", flight: "AR1303", passengers: 2, largeBags: 2, carryOn: 2, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Emma Wilson", phone: "+447700900001", locale: "en" }, state: "needs_driver" },
  { reference: "STT-DEM002", dayOffset: 1, direction: "from_airport", airport: "AEP", zoneCode: "recoleta", placeText: "Av. Alvear 1891, Recoleta", time: "09:15", flight: "LA4521", passengers: 4, largeBags: 4, carryOn: 2, vehicleClass: "minivan", paymentMode: "pay_on_pickup_cash", passenger: { name: "Familia Pereyra", phone: "+5491155550002", locale: "es-AR" }, state: "confirmed", driverIndex: 1 },
  { reference: "STT-DEM003", dayOffset: 1, direction: "to_airport", airport: "EZE", zoneCode: "microcentro", placeText: "Florida 165, Microcentro", time: "11:00", flight: null, passengers: 3, largeBags: 2, carryOn: 1, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Jean Dupont", phone: "+33612345678", locale: "en" }, state: "held", driverIndex: 0 },
  { reference: "STT-DEM004", dayOffset: 1, direction: "from_airport", airport: "EZE", zoneCode: "puerto_madero", placeText: "Hotel Faena, Martha Salotti 445", time: "13:20", flight: "AA997", passengers: 1, largeBags: 1, carryOn: 1, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Michael Chen", phone: "+14155550104", locale: "en" }, state: "needs_driver", notes: "Viaja con silla de ruedas plegable." },
  { reference: "STT-DEM005", dayOffset: 1, direction: "to_airport", airport: "AEP", zoneCode: "belgrano", placeText: "Av. Cabildo 2040, Belgrano", time: "16:30", flight: null, passengers: 10, largeBags: 10, carryOn: 6, vehicleClass: "taxibus", paymentMode: "pay_on_pickup_cash", passenger: { name: "Club Atlético Belgrano (delegación)", phone: "+5491155550005", locale: "es-AR" }, state: "confirmed", driverIndex: 5 },
  { reference: "STT-DEM006", dayOffset: 1, direction: "from_airport", airport: "EZE", zoneCode: "palermo", placeText: "Gorriti 4800, Palermo", time: "21:50", flight: "IB6845", passengers: 2, largeBags: 2, carryOn: 0, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Lucía Martín", phone: "+34600111222", locale: "es-AR" }, state: "needs_driver" },
  { reference: "STT-DEM007", dayOffset: 2, direction: "to_airport", airport: "EZE", zoneCode: "recoleta", placeText: "Posadas 1350, Recoleta", time: "05:00", flight: null, passengers: 2, largeBags: 2, carryOn: 2, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Hans Müller", phone: "+491511234567", locale: "en" }, state: "confirmed", driverIndex: 0 },
  { reference: "STT-DEM008", dayOffset: 2, direction: "from_airport", airport: "AEP", zoneCode: "microcentro", placeText: "Reconquista 600", time: "12:10", flight: "AR1855", passengers: 1, largeBags: 1, carryOn: 1, vehicleClass: "sedan_premium", paymentMode: "prepaid", passenger: { name: "Valentina Ríos", phone: "+5491155550008", locale: "es-AR" }, state: "cancelled" },
];

export function demoOperatorConfig(): OperatorConfig {
  return {
    operatorId: DEMO_OPERATOR_ID,
    slug: "soytutaxi",
    name: "SoyTuTaxi",
    timezone: "America/Argentina/Buenos_Aires",
    demoMode: true,
    vehicleClasses: DEMO_VEHICLE_CLASSES,
    airports: DEMO_AIRPORTS,
    zones: DEMO_ZONES,
    fareRules: DEMO_FARE_RULES,
    policy: DEMO_POLICY,
  };
}
