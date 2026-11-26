import type {
  BookingSource, ContactInput, MemberRole, NormalizedJourney, OperatorConfig, PaymentMode, FareBreakdown,
} from "../domain/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public fields?: { field: string; code: string }[],
    public extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export interface Actor {
  userId: string;
  roles: MemberRole[];
}

export interface QuoteRow {
  operatorId: string;
  sessionHash: string;
  source: BookingSource;
  kind: "priced" | "manual";
  journey: NormalizedJourney;
  vehicleClass: string | null;
  fare: FareBreakdown | null;
  policyId: string;
  manualReasons: string[];
  expiresAt: string;
}

export interface CreateBookingArgs {
  operatorId: string;
  quoteId: string;
  sessionHash: string;
  idempotencyKey: string;
  requestHash: string;
  contact: ContactInput;
  paymentMode: PaymentMode;
  notes: string | null;
  statusTokenHash: string;
  actorId: string | null;
  flightExceptionReason: string | null;
  requestId: string;
}

export interface CreateBookingResult {
  bookingId: string;
  reference: string;
  state: string;
  replay: boolean;
}

export interface BookingStatusView {
  reference: string;
  bookingState: string;
  direction: string;
  airport: string;
  airportName: string;
  meetingPoint: { es: string; en: string };
  pickup: unknown;
  dropoff: unknown;
  agreedPickupAt: string;
  proposedPickupAt: string | null;
  passengers: number;
  largeBags: number;
  carryOn: number;
  vehicleClass: string;
  flight: null | { designator: string; localArrivalDate: string };
  amountMinor: number | null;
  currency: string | null;
  paymentMode: string;
  collectionState: string;
  locale: string;
  driverAssigned: boolean;
  allowedActions: string[];
  createdAt: string;
}

/**
 * Persistence port. The Supabase implementation delegates the transactional work to PostgreSQL
 * functions (see migrations); the memory implementation mirrors those rules for demo mode/tests.
 */
export interface Store {
  loadConfig(operatorSlug: string): Promise<OperatorConfig | null>;
  insertQuote(row: QuoteRow): Promise<{ id: string }>;
  createBooking(args: CreateBookingArgs): Promise<CreateBookingResult>;
  getBookingStatus(reference: string, statusTokenHash: string): Promise<BookingStatusView | null>;
  /** Resolve a bearer token to a staff actor for the operator, or null. */
  resolveActor(bearer: string, operatorId: string): Promise<Actor | null>;
}
