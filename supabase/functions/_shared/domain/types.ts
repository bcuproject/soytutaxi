// Shared domain types. Runs unchanged in Deno (Edge Functions), the browser and Node (tests).

export type Direction = "from_airport" | "to_airport";
export type Locale = "es-AR" | "en";
export type PaymentMode = "prepaid" | "pay_on_pickup_cash" | "pay_on_pickup_card";
export type BookingSource = "web" | "whatsapp" | "staff" | "phone" | "voice";
export type BookingState = "requested" | "needs_driver" | "held" | "confirmed" | "closed" | "cancelled";
export type CollectionState = "not_applicable" | "awaiting_payment" | "pending_collection" | "collected" | "waived";
export type AssignmentState = "reserving" | "confirmed" | "released";
export type TripStage = "scheduled" | "en_route" | "at_pickup" | "onboard" | "complete" | "no_show";
export type MemberRole = "admin" | "dispatcher" | "finance" | "driver" | "agent";

export interface VehicleClass {
  code: string;
  labelEs: string;
  labelEn: string;
  maxPassengers: number;
  maxLargeBags: number;
  maxCarryOn: number;
  /** Joint rule: large bag = 2 units, carry-on = 1 unit. null = no joint rule. */
  maxBagUnits: number | null;
  sortOrder: number;
  active: boolean;
}

export interface Airport {
  id: string;
  iata: string;
  name: string;
  meetingPointEs: string;
  meetingPointEn: string;
  lat: number;
  lng: number;
  active: boolean;
}

/** GeoJSON-style polygon: outer ring of [lng, lat] pairs. */
export type Ring = [number, number][];

export interface Zone {
  id: string;
  code: string;
  name: string;
  polygon: Ring[];
  active: boolean;
}

export interface FareRule {
  id: string;
  direction: Direction;
  airportId: string;
  /** null = applies to any served zone (less specific than a zone rule). */
  zoneId: string | null;
  vehicleClass: string;
  /** Lower rank wins. */
  rank: number;
  amountMinor: number;
  taxesMinor: number;
  currency: string;
  estDurationMin: number;
  /** Inclusive local date YYYY-MM-DD. */
  effectiveFrom: string;
  /** Exclusive local date YYYY-MM-DD, or null for open-ended. */
  effectiveTo: string | null;
  version: number;
  active: boolean;
  isDemo: boolean;
}

export interface PolicyConfig {
  quote_expiry_minutes: number;
  lead_time_minutes: number;
  max_advance_days: number;
  hold_minutes: number;
  offer_expiry_minutes: number;
  auto_offer_group_size: number;
  turnaround_minutes: number;
  /** Baggage/immigration buffer added to flight arrival, per airport IATA. */
  arrival_buffer_minutes: Record<string, number>;
  allowed_payment_modes: PaymentMode[];
  waiting: { free_wait_minutes_airport: number; free_wait_minutes_city: number; no_show_after_minutes: number };
  cancellation: { free_until_hours_before: number; refund_percent_after: number };
  flight_monitoring: { start_hours_before: number; interval_minutes: number; change_threshold_minutes: number; taxi_to_gate_minutes: number };
  escalation: { unassigned_alert_hours_before: number; paid_without_cover_alert_minutes: number };
}

export interface Policy {
  id: string;
  version: number;
  label: string;
  isDemo: boolean;
  config: PolicyConfig;
}

export interface Vehicle {
  id: string;
  vehicleClass: string;
  plate: string;
  description: string;
  active: boolean;
}

export interface Driver {
  id: string;
  fullName: string;
  whatsappE164: string;
  approvalStatus: "pending" | "approved" | "suspended" | "rejected";
  active: boolean;
  vehicleId: string | null;
}

export interface OperatorConfig {
  operatorId: string;
  slug: string;
  name: string;
  timezone: string;
  demoMode: boolean;
  vehicleClasses: VehicleClass[];
  airports: Airport[];
  zones: Zone[];
  fareRules: FareRule[];
  policy: Policy;
}

export interface PlaceInput {
  text: string;
  lat?: number | null;
  lng?: number | null;
}

/** What a passenger (or staff) submits for a quote. */
export interface JourneyInput {
  direction: Direction;
  airport: string;           // IATA
  zoneCode: string;          // city-side service zone
  place: PlaceInput;         // city-side address
  /** Local date YYYY-MM-DD. from_airport: flight arrival date; to_airport: pickup date. */
  date: string;
  /** Local time HH:mm. from_airport: scheduled arrival; to_airport: pickup time. */
  time: string;
  flightDesignator?: string | null;
  passengers: number;
  largeBags: number;
  carryOn: number;
  vehicleClass?: string | null;
  locale: Locale;
}

export interface Place {
  label: string;
  originalText: string;
  lat: number | null;
  lng: number | null;
  verified: boolean;
  zoneCode: string | null;
  kind: "airport" | "address";
}

export interface NormalizedJourney {
  direction: Direction;
  airportIata: string;
  airportId: string;
  zoneId: string;
  zoneCode: string;
  pickup: Place;
  dropoff: Place;
  /** UTC ISO instant of agreed pickup. */
  pickupAt: string;
  pickupLocalDate: string;
  pickupLocalTime: string;
  flight: null | {
    designator: string;
    localArrivalDate: string;
    scheduledArrivalAt: string; // UTC ISO
    scheduledArrivalLocal: string; // HH:mm
    bufferMinutes: number;
  };
  passengers: number;
  largeBags: number;
  carryOn: number;
  locale: Locale;
}

export interface FieldError {
  field: string;
  code: string;
}

export interface VehicleOption {
  code: string;
  eligible: boolean;
  reasons: string[];
  amountMinor: number | null;
  currency: string | null;
}

export interface FareBreakdown {
  baseMinor: number;
  taxesMinor: number;
  totalMinor: number;
  currency: string;
  fareRuleId: string;
  fareRuleVersion: number;
  estDurationMin: number;
  isDemo: boolean;
}

export type QuoteComputation =
  | { kind: "invalid"; errors: FieldError[]; options?: VehicleOption[] }
  | { kind: "priced"; journey: NormalizedJourney; vehicleClass: string; fare: FareBreakdown; options: VehicleOption[] }
  | { kind: "manual"; journey: NormalizedJourney; vehicleClass: string | null; reasons: string[]; options: VehicleOption[] };

export interface ContactInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  locale: Locale;
}
