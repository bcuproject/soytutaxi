// In-memory Store for DEMO MODE and unit tests. Mirrors the rules of
// public.create_booking_from_quote (authoritative implementation lives in PostgreSQL).

import { DEMO_BOOKINGS, DEMO_DRIVERS, DEMO_STAFF, DEMO_VEHICLES, demoOperatorConfig } from "../domain/fixtures.ts";
import { computeQuote } from "../domain/quote.ts";
import { addDaysLocal, addMinutes, utcToLocalDate } from "../domain/time.ts";
import type {
  BookingState, CollectionState, ContactInput, Driver, MemberRole, NormalizedJourney, OperatorConfig, PaymentMode,
  Vehicle, BookingSource, AssignmentState, TripStage,
} from "../domain/types.ts";
import {
  ApiError, type Actor, type BookingStatusView, type CreateBookingArgs, type CreateBookingResult, type QuoteRow, type Store,
} from "./store.ts";

interface MemQuote extends QuoteRow {
  id: string;
  consumedBookingId: string | null;
}

export interface MemBooking {
  id: string;
  reference: string;
  source: BookingSource;
  quoteId: string;
  journey: NormalizedJourney;
  vehicleClass: string;
  contact: ContactInput;
  paymentMode: PaymentMode;
  collectionState: CollectionState;
  amountMinor: number | null;
  currency: string | null;
  estDurationMin: number;
  state: BookingState;
  notes: string | null;
  idempotencyKey: string;
  requestHash: string;
  statusTokenHash: string;
  flightExceptionReason: string | null;
  version: number;
  createdAt: string;
  cancelledReason: string | null;
}

export interface MemAssignment {
  id: string;
  bookingId: string;
  driverId: string;
  vehicleId: string;
  state: AssignmentState;
  tripStage: TripStage;
  holdExpiresAt: string | null;
  occupiedFrom: string;
  occupiedTo: string;
}

export interface MemEvent {
  bookingId: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  actor: string;
  at: string;
  payload: Record<string, unknown>;
}

/** Row shape of public.dispatch_booking_rows (camelCased). */
export interface DispatchRow {
  id: string;
  reference: string;
  source: BookingSource;
  state: BookingState;
  direction: "from_airport" | "to_airport";
  airport: string;
  zoneName: string | null;
  pickupPlace: { label: string; originalText?: string };
  dropoffPlace: { label: string; originalText?: string };
  agreedPickupAt: string;
  proposedPickupAt: string | null;
  estDurationMin: number;
  pickupLocalDate: string;
  passengers: number;
  largeBags: number;
  carryOn: number;
  vehicleClass: string;
  flightDesignator: string | null;
  flightLocalArrivalDate: string | null;
  flightExceptionReason: string | null;
  paymentMode: PaymentMode;
  collectionState: CollectionState;
  amountMinor: number | null;
  currency: string | null;
  version: number;
  notes: string | null;
  createdAt: string;
  passengerName: string;
  passengerPhone: string | null;
  passengerEmail: string | null;
  locale: string;
  assignmentId: string | null;
  assignmentState: AssignmentState | null;
  tripStage: TripStage | null;
  holdExpiresAt: string | null;
  driverId: string | null;
  driverName: string | null;
  vehicleId: string | null;
  vehiclePlate: string | null;
}

let seq = 0;
const uuid = () => (typeof globalThis.crypto?.randomUUID === "function" ? crypto.randomUUID() : `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`);
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export class MemoryStore implements Store {
  cfg: OperatorConfig;
  quotes = new Map<string, MemQuote>();
  bookings = new Map<string, MemBooking>();
  assignments: MemAssignment[] = [];
  events: MemEvent[] = [];
  outbox: { kind: string; dedupeKey: string }[] = [];
  drivers: Driver[] = DEMO_DRIVERS;
  vehicles: Vehicle[] = DEMO_VEHICLES;
  /** bearer token → actor, for demo staff sign-in. */
  actors = new Map<string, Actor>();

  constructor(private clock: () => Date = () => new Date(), cfg: OperatorConfig = demoOperatorConfig()) {
    this.cfg = cfg;
    for (const s of DEMO_STAFF) this.actors.set(`demo-${s.role}`, { userId: s.userId, roles: [s.role as MemberRole] });
  }

  async loadConfig(slug: string) {
    return slug === this.cfg.slug ? this.cfg : null;
  }

  async insertQuote(row: QuoteRow) {
    const id = uuid();
    this.quotes.set(id, { ...row, id, consumedBookingId: null });
    return { id };
  }

  async createBooking(a: CreateBookingArgs): Promise<CreateBookingResult> {
    const now = this.clock();
    const q = this.quotes.get(a.quoteId);
    const existing = [...this.bookings.values()].find((b) => b.idempotencyKey === a.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== a.requestHash) throw new ApiError(409, "idempotency_conflict", "This idempotency key was used with a different request.");
      return { bookingId: existing.id, reference: existing.reference, state: existing.state, replay: true };
    }
    if (!q || q.operatorId !== a.operatorId || q.sessionHash !== a.sessionHash) throw new ApiError(404, "quote_not_found");
    if (q.kind !== "priced" || !q.fare || !q.vehicleClass) throw new ApiError(422, "manual_quote_required", "This journey needs a manual quote from staff.");
    if (q.consumedBookingId) throw new ApiError(409, "quote_already_used");
    if (new Date(q.expiresAt) <= now) throw new ApiError(422, "quote_expired", "The quote has expired. Request a new quote.");
    const pol = this.cfg.policy.config;
    if (!pol.allowed_payment_modes.includes(a.paymentMode)) throw new ApiError(422, "payment_mode_not_allowed");
    if (new Date(q.journey.pickupAt) < addMinutes(now, pol.lead_time_minutes)) throw new ApiError(422, "pickup_too_soon", "Pickup is inside the minimum booking lead time.");
    if (!a.contact.name.trim()) throw new ApiError(422, "contact_name_required");
    if (!a.contact.phone && !a.contact.email) throw new ApiError(422, "contact_unreachable");
    if (q.journey.direction === "from_airport" && !q.journey.flight) {
      if (!a.flightExceptionReason) throw new ApiError(422, "flight_required");
      const actor = [...this.actors.values()].find((x) => x.userId === a.actorId);
      if (!actor || !actor.roles.some((r) => r === "admin" || r === "dispatcher")) throw new ApiError(403, "flight_exception_not_permitted");
    }

    let reference: string;
    do {
      reference = "STT-" + Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
    } while ([...this.bookings.values()].some((b) => b.reference === reference));

    const b: MemBooking = {
      id: uuid(), reference, source: q.source, quoteId: q.id, journey: q.journey, vehicleClass: q.vehicleClass,
      contact: a.contact, paymentMode: a.paymentMode,
      collectionState: a.paymentMode === "prepaid" ? "awaiting_payment" : "pending_collection",
      amountMinor: q.fare.totalMinor, currency: q.fare.currency, estDurationMin: q.fare.estDurationMin,
      state: "needs_driver", notes: a.notes, idempotencyKey: a.idempotencyKey, requestHash: a.requestHash,
      statusTokenHash: a.statusTokenHash, flightExceptionReason: a.flightExceptionReason, version: 1,
      createdAt: now.toISOString(), cancelledReason: null,
    };
    this.bookings.set(b.id, b);
    q.consumedBookingId = b.id;
    this.events.push({ bookingId: b.id, kind: "booking.created", fromValue: null, toValue: "needs_driver", actor: a.actorId ? "staff" : "passenger", at: now.toISOString(), payload: { source: q.source, paymentMode: a.paymentMode } });
    this.outbox.push({ kind: "notify.passenger.booking_received", dedupeKey: `booking:${b.id}:received` });
    this.outbox.push({ kind: "dispatch.needs_driver", dedupeKey: `booking:${b.id}:needs_driver:v1` });
    return { bookingId: b.id, reference, state: b.state, replay: false };
  }

  async getBookingStatus(reference: string, tokenHash: string): Promise<BookingStatusView | null> {
    const b = [...this.bookings.values()].find((x) => x.reference === reference && x.statusTokenHash === tokenHash);
    if (!b) return null;
    const airport = this.cfg.airports.find((x) => x.iata === b.journey.airportIata)!;
    return {
      reference: b.reference, bookingState: b.state, direction: b.journey.direction, airport: airport.iata,
      airportName: airport.name, meetingPoint: { es: airport.meetingPointEs, en: airport.meetingPointEn },
      pickup: b.journey.pickup, dropoff: b.journey.dropoff, agreedPickupAt: b.journey.pickupAt, proposedPickupAt: null,
      passengers: b.journey.passengers, largeBags: b.journey.largeBags, carryOn: b.journey.carryOn,
      vehicleClass: b.vehicleClass,
      flight: b.journey.flight ? { designator: b.journey.flight.designator, localArrivalDate: b.journey.flight.localArrivalDate } : null,
      amountMinor: b.amountMinor, currency: b.currency, paymentMode: b.paymentMode, collectionState: b.collectionState,
      locale: b.contact.locale,
      driverAssigned: this.assignments.some((s) => s.bookingId === b.id && s.state === "confirmed"),
      allowedActions: b.state === "cancelled" || b.state === "closed" ? [] : ["contact_staff", "request_change"],
      createdAt: b.createdAt,
    };
  }

  async resolveActor(bearer: string) {
    return this.actors.get(bearer) ?? null;
  }

  // --- demo-only read model -------------------------------------------------------------------
  dispatchRows(): DispatchRow[] {
    return [...this.bookings.values()].map((b) => {
      const s = this.assignments.find((x) => x.bookingId === b.id && x.state !== "released");
      const d = s ? this.drivers.find((x) => x.id === s.driverId) : undefined;
      const v = s ? this.vehicles.find((x) => x.id === s.vehicleId) : undefined;
      const zone = this.cfg.zones.find((z) => z.id === b.journey.zoneId);
      return {
        id: b.id, reference: b.reference, source: b.source, state: b.state, direction: b.journey.direction,
        airport: b.journey.airportIata, zoneName: zone?.name ?? null,
        pickupPlace: b.journey.pickup, dropoffPlace: b.journey.dropoff,
        agreedPickupAt: b.journey.pickupAt, proposedPickupAt: null, estDurationMin: b.estDurationMin,
        pickupLocalDate: utcToLocalDate(new Date(b.journey.pickupAt), this.cfg.timezone),
        passengers: b.journey.passengers, largeBags: b.journey.largeBags, carryOn: b.journey.carryOn,
        vehicleClass: b.vehicleClass, flightDesignator: b.journey.flight?.designator ?? null,
        flightLocalArrivalDate: b.journey.flight?.localArrivalDate ?? null, flightExceptionReason: b.flightExceptionReason,
        paymentMode: b.paymentMode, collectionState: b.collectionState, amountMinor: b.amountMinor, currency: b.currency,
        version: b.version, notes: b.notes, createdAt: b.createdAt,
        passengerName: b.contact.name, passengerPhone: b.contact.phone ?? null, passengerEmail: b.contact.email ?? null,
        locale: b.contact.locale,
        assignmentId: s?.id ?? null, assignmentState: s?.state ?? null, tripStage: s?.tripStage ?? null,
        holdExpiresAt: s?.holdExpiresAt ?? null, driverId: d?.id ?? null, driverName: d?.fullName ?? null,
        vehicleId: v?.id ?? null, vehiclePlate: v?.plate ?? null,
      };
    }).sort((a, b) => a.agreedPickupAt.localeCompare(b.agreedPickupAt));
  }

  eventsFor(bookingId: string): MemEvent[] {
    return this.events.filter((e) => e.bookingId === bookingId);
  }

  /** Load DEMO_BOOKINGS relative to today in Buenos Aires (bypasses lead-time checks, like the SQL seed). */
  seedDemoBookings(): void {
    const now = this.clock();
    const today = utcToLocalDate(now, this.cfg.timezone);
    // Seed as if quoted a week ago so lead-time/advance rules don't reject near-term demo trips.
    const quoteClock = addMinutes(now, -7 * 24 * 60);
    const relaxed: OperatorConfig = { ...this.cfg, policy: { ...this.cfg.policy, config: { ...this.cfg.policy.config, lead_time_minutes: 0 } } };
    for (const d of DEMO_BOOKINGS) {
      const r = computeQuote({
        direction: d.direction, airport: d.airport, zoneCode: d.zoneCode, place: { text: d.placeText },
        date: addDaysLocal(today, d.dayOffset), time: d.time, flightDesignator: d.flight,
        passengers: d.passengers, largeBags: d.largeBags, carryOn: d.carryOn, vehicleClass: d.vehicleClass,
        locale: d.passenger.locale,
      }, relaxed, { now: quoteClock });
      if (r.kind !== "priced") throw new Error(`demo booking ${d.reference} not priced: ${JSON.stringify(r)}`);
      const id = uuid();
      const createdAt = addMinutes(now, -60 * (DEMO_BOOKINGS.indexOf(d) + 2)).toISOString();
      this.bookings.set(id, {
        id, reference: d.reference, source: "web", quoteId: uuid(), journey: r.journey, vehicleClass: r.vehicleClass,
        contact: { name: d.passenger.name, phone: d.passenger.phone, email: null, locale: d.passenger.locale },
        paymentMode: d.paymentMode,
        collectionState: d.paymentMode === "prepaid" ? (d.state === "confirmed" ? "collected" : "awaiting_payment") : "pending_collection",
        amountMinor: r.fare.totalMinor, currency: r.fare.currency, estDurationMin: r.fare.estDurationMin,
        state: d.state, notes: d.notes ?? null, idempotencyKey: `demo-${d.reference}`, requestHash: "demo",
        statusTokenHash: "demo", flightExceptionReason: null, version: 1, createdAt,
        cancelledReason: d.state === "cancelled" ? "Cancelado por el pasajero (demo)" : null,
      });
      this.events.push({ bookingId: id, kind: "booking.created", fromValue: null, toValue: "needs_driver", actor: "passenger", at: createdAt, payload: { source: "web" } });
      if (d.driverIndex !== undefined && d.state !== "cancelled") {
        const driver = this.drivers[d.driverIndex];
        const start = new Date(r.journey.pickupAt);
        const end = addMinutes(start, r.fare.estDurationMin + this.cfg.policy.config.turnaround_minutes);
        this.assignments.push({
          id: uuid(), bookingId: id, driverId: driver.id, vehicleId: driver.vehicleId!,
          state: d.state === "held" ? "reserving" : "confirmed", tripStage: "scheduled",
          holdExpiresAt: d.state === "held" ? addMinutes(now, 12).toISOString() : null,
          occupiedFrom: start.toISOString(), occupiedTo: end.toISOString(),
        });
        this.events.push({ bookingId: id, kind: "booking.state_changed", fromValue: "needs_driver", toValue: d.state, actor: "dispatcher", at: addMinutes(new Date(createdAt), 20).toISOString(), payload: { driver: driver.fullName } });
      }
      if (d.state === "cancelled") {
        this.events.push({ bookingId: id, kind: "booking.state_changed", fromValue: "needs_driver", toValue: "cancelled", actor: "dispatcher", at: addMinutes(new Date(createdAt), 30).toISOString(), payload: { reason: "Cancelado por el pasajero (demo)" } });
      }
    }
  }
}
