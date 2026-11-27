// Front-end backend port. DEMO mode runs the real API handler in the browser against MemoryStore;
// LIVE mode calls the `api` Edge Function and reads dispatch data through Supabase with RLS.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handle } from "@shared/api/handler.ts";
import { MemoryStore, type DispatchRow, type MemEvent } from "@shared/api/memoryStore.ts";
import { DEMO_DRIVERS } from "@shared/domain/fixtures.ts";
import type { BookingStatusView } from "@shared/api/store.ts";
import type { Driver, TripStage } from "@shared/domain/types.ts";

export type { DispatchRow, MemEvent as TripEvent };

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  fields?: { field: string; code: string }[];
  vehicleOptions?: unknown[];
}

export class ApiFailure extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
}

export interface StaffSession {
  email: string;
  label: string;
}

export interface WaConversation {
  id: string; waId: string; phone: string; name: string | null; kind: "passenger" | "driver"; locale: string; step: string;
  needsStaff: boolean; handoffOwner: string | null; handledByMe: boolean; windowOpen: boolean; version: number;
  lastBookingRef: string | null; lastPreview: string | null; lastDirection: "in" | "out" | null; lastAt: string | null; updatedAt: string;
}
export interface WaMessage {
  id: string; direction: "in" | "out"; kind: string; preview: string; status: string; error: string | null; staff: boolean; at: string;
}

export interface Backend {
  mode: "demo" | "live";
  api<T>(method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  dispatchRows(fromIso: string, toIso: string): Promise<DispatchRow[]>;
  tripEvents(bookingId: string): Promise<MemEvent[]>;
  drivers(): Promise<Driver[]>;
  staffSession(): Promise<StaffSession | null>;
  signIn(email: string, password: string): Promise<StaffSession>;
  signInDemo(): Promise<StaffSession>;
  signOut(): Promise<void>;
  /** Authorization header for staff-originated API calls, if signed in. */
  staffAuthHeader(): Promise<Record<string, string>>;

  // --- Phase 2: dispatch operations ------------------------------------------------------------
  driverBoard(): Promise<BoardRow[]>;
  assign(bookingId: string, driverId: string, version: number, reason?: string): Promise<void>;
  offer(bookingId: string, version: number, groupSize: number, driverIds?: string[]): Promise<{ offered: number; expires_at: string }>;
  release(bookingId: string, version: number, reason: string): Promise<void>;
  cancel(bookingId: string, version: number, reason: string): Promise<void>;
  /** Live updates (locations, bookings, assignments, offers). Returns an unsubscribe function. */
  subscribe(onChange: (table: string) => void): () => void;

  // --- Phase 2: driver app ---------------------------------------------------------------------
  driverMe(): Promise<DriverMe>;
  setShift(on: boolean): Promise<void>;
  reportLocation(p: { lat: number; lng: number; accuracy?: number | null; heading?: number | null; speed?: number | null; at: string }): Promise<void>;
  driverOffers(): Promise<DriverOffer[]>;
  respondOffer(offerId: string, accept: boolean): Promise<{ outcome: string }>;
  driverJobs(): Promise<DriverJob[]>;
  progress(assignmentId: string, stage: TripStage, version: number): Promise<void>;
  jobBoard(): Promise<JobBoard>;
  claim(bookingId: string): Promise<{ outcome: string }>;
  giveBack(assignmentId: string, reason?: string): Promise<{ outcome: string; on_board: boolean }>;
  boardAction(bookingId: string, action: "hold" | "publish" | "auto", version: number): Promise<void>;

  // --- Walkie-talkie -----------------------------------------------------------------------------
  radioToken(): Promise<{ url: string; token: string; room: string; name: string }>;

  // --- WhatsApp inbox ----------------------------------------------------------------------------
  waConversations(): Promise<WaConversation[]>;
  waMessages(conversationId: string): Promise<WaMessage[]>;
  waTakeover(conversationId: string, take: boolean): Promise<void>;
  waSend(conversationId: string, text: string): Promise<void>;
}

export interface BoardRow {
  driverId: string;
  fullName: string;
  onShift: boolean;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  recordedAt: string | null;
  vehiclePlate: string | null;
  vehicleClass: string | null;
  currentReference: string | null;
  currentStage: string | null;
  mapStatus: "off" | "stale" | "free" | "to_pickup" | "onboard";
}

export interface DriverMe {
  id: string;
  fullName: string;
  onShift: boolean;
  vehicle: { plate: string; class: string; description: string } | null;
  earnings: { accruedMinor: number; settledMinor: number; todayMinor: number; currency: string; trips: number };
  cashToHandInMinor: number;
}

export interface DriverOffer {
  id: string; expiresAt: string; earningsMinor: number; currency: string; pickupAt: string;
  direction: "from_airport" | "to_airport"; airport: string; zone: string | null;
  passengers: number; largeBags: number; carryOn: number; vehicleClass: string; estDurationMin: number; flight: string | null;
}

export interface BoardJob {
  bookingId: string; pickupAt: string; pickupLocalDate: string; direction: "from_airport" | "to_airport";
  airport: string; zone: string | null; flight: string | null; passengers: number; largeBags: number; carryOn: number;
  vehicleClass: string; estDurationMin: number; earningsMinor: number; currency: string;
}
export interface JobBoard { maxPerDay: number; releaseUntilHours: number; escalateHours: number; claimsByDay: Record<string, number>; jobs: BoardJob[] }

export interface DriverJob {
  assignmentId: string; version: number; state: string; tripStage: TripStage; holdExpiresAt: string | null;
  reference: string; bookingState: string; direction: "from_airport" | "to_airport"; airport: string; meetingPoint: string;
  pickup: { label: string; lat?: number | null; lng?: number | null }; dropoff: { label: string; lat?: number | null; lng?: number | null };
  zone: string | null; pickupAt: string; proposedPickupAt: string | null; estDurationMin: number;
  passengers: number; largeBags: number; carryOn: number; vehicleClass: string; flight: string | null; notes: string | null;
  paymentMode: string; collectionState: string; amountMinor: number | null; currency: string | null; earningsMinor: number | null;
  claimSource: "staff" | "offer" | "board" | null; canDrop: boolean;
  passenger: { name: string; phone: string | null; locale: string };
}

/** Error from a database command: code is the machine code (e.g. stale_version, schedule_conflict). */
export class CommandError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

const LIVE_ONLY = () => new CommandError("live_only", "Disponible solo en modo en vivo (con Supabase).");

// --- guest session id (binds quotes to this browser) -------------------------------------------
export function guestSessionId(): string {
  const KEY = "stt_session";
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
  } catch { /* storage unavailable */ }
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  return id;
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ error: { code: "bad_response", message: "Bad response", requestId: "" } }));
  if (!res.ok) throw new ApiFailure(res.status, body.error);
  return body as T;
}

// --- demo -------------------------------------------------------------------------------------
class DemoBackend implements Backend {
  mode = "demo" as const;
  private store = new MemoryStore();
  private staff: StaffSession | null = null;
  constructor() {
    this.store.seedDemoBookings();
  }
  async api<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
    const req = new Request(`${location.origin}/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-session-id": guestSessionId(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Small artificial latency so loading states are visible in demo.
    await new Promise((r) => setTimeout(r, 250));
    return parse<T>(await handle(req, {
      store: this.store, statusTokenSecret: "demo-only-secret", operatorSlug: "soytutaxi", publicAppUrl: location.origin,
    }));
  }
  async dispatchRows(fromIso: string, toIso: string) {
    return this.store.dispatchRows().filter((r) => r.agreedPickupAt >= fromIso && r.agreedPickupAt < toIso);
  }
  async tripEvents(id: string) {
    return this.store.eventsFor(id);
  }
  async drivers() {
    return DEMO_DRIVERS;
  }
  async staffSession() {
    return this.staff;
  }
  async signIn(): Promise<StaffSession> {
    return this.signInDemo();
  }
  async signInDemo() {
    this.staff = { email: "despacho@demo.soytutaxi.test", label: "Despacho (demo)" };
    return this.staff;
  }
  async signOut() {
    this.staff = null;
  }
  async staffAuthHeader(): Promise<Record<string, string>> {
    return this.staff ? { authorization: "Bearer demo-dispatcher" } : {};
  }

  // Demo map: drivers drift around Buenos Aires so the panel can be previewed without phones.
  private sim = new Map<string, { lat: number; lng: number; dLat: number; dLng: number }>();
  async driverBoard(): Promise<BoardRow[]> {
    const rows = this.store.dispatchRows();
    return DEMO_DRIVERS.filter((d) => d.approvalStatus === "approved").map((d, i) => {
      let p = this.sim.get(d.id);
      if (!p) {
        p = { lat: -34.6 + (i - 3) * 0.03, lng: -58.44 + ((i * 37) % 7 - 3) * 0.025, dLat: (i % 2 ? 1 : -1) * 0.0007, dLng: (i % 3 ? 1 : -1) * 0.0009 };
        this.sim.set(d.id, p);
      }
      p.lat += p.dLat; p.lng += p.dLng;
      if (Math.abs(p.lat + 34.6) > 0.06) p.dLat *= -1;
      if (Math.abs(p.lng + 58.42) > 0.07) p.dLng *= -1;
      const job = rows.find((r) => r.driverId === d.id && r.state === "confirmed");
      const status = i === 4 ? "off" : i === 1 ? "onboard" : i === 0 ? "to_pickup" : "free";
      return {
        driverId: d.id, fullName: d.fullName, onShift: status !== "off", lat: status === "off" ? null : p.lat, lng: status === "off" ? null : p.lng,
        heading: (Math.atan2(p.dLng, p.dLat) * 180 / Math.PI + 360) % 360, recordedAt: status === "off" ? null : new Date().toISOString(),
        vehiclePlate: this.store.vehicles.find((v) => v.id === d.vehicleId)?.plate ?? null, vehicleClass: this.store.vehicles.find((v) => v.id === d.vehicleId)?.vehicleClass ?? null,
        currentReference: status === "onboard" || status === "to_pickup" ? job?.reference ?? null : null, currentStage: null, mapStatus: status as BoardRow["mapStatus"],
      };
    });
  }
  async assign(): Promise<void> { throw LIVE_ONLY(); }
  async offer(): Promise<{ offered: number; expires_at: string }> { throw LIVE_ONLY(); }
  async release(): Promise<void> { throw LIVE_ONLY(); }
  async cancel(): Promise<void> { throw LIVE_ONLY(); }
  subscribe(onChange: (t: string) => void) {
    const i = setInterval(() => onChange("driver_locations"), 3000);
    return () => clearInterval(i);
  }
  async driverMe(): Promise<DriverMe> { throw LIVE_ONLY(); }
  async setShift(): Promise<void> { throw LIVE_ONLY(); }
  async reportLocation(): Promise<void> { throw LIVE_ONLY(); }
  async driverOffers(): Promise<DriverOffer[]> { throw LIVE_ONLY(); }
  async respondOffer(): Promise<{ outcome: string }> { throw LIVE_ONLY(); }
  async driverJobs(): Promise<DriverJob[]> { throw LIVE_ONLY(); }
  async progress(): Promise<void> { throw LIVE_ONLY(); }
  async jobBoard(): Promise<JobBoard> { throw LIVE_ONLY(); }
  async claim(): Promise<{ outcome: string }> { throw LIVE_ONLY(); }
  async giveBack(): Promise<{ outcome: string; on_board: boolean }> { throw LIVE_ONLY(); }
  async boardAction(): Promise<void> { throw LIVE_ONLY(); }
  async radioToken(): Promise<{ url: string; token: string; room: string; name: string }> { throw LIVE_ONLY(); }

  private wa = demoWhatsApp();
  async waConversations() { return [...this.wa.convs].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "")); }
  async waMessages(id: string) { return this.wa.msgs[id] ?? []; }
  async waTakeover(id: string, take: boolean) {
    const c = this.wa.convs.find((x) => x.id === id)!;
    Object.assign(c, take ? { handoffOwner: "demo", handledByMe: true } : { handoffOwner: null, handledByMe: false, needsStaff: false, step: "menu" });
  }
  async waSend(id: string, text: string) {
    const c = this.wa.convs.find((x) => x.id === id)!;
    const at = new Date().toISOString();
    (this.wa.msgs[id] ??= []).push({ id: `m${Date.now()}`, direction: "out", kind: "text", preview: text, status: "sent", error: null, staff: true, at });
    Object.assign(c, { lastPreview: text, lastDirection: "out", lastAt: at });
  }
}

function demoWhatsApp() {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const conv = (id: string, name: string, waId: string, o: Partial<WaConversation>): WaConversation => ({
    id, waId, phone: `+${waId}`, name, kind: "passenger", locale: "es-AR", step: "done", needsStaff: false, handoffOwner: null,
    handledByMe: false, windowOpen: true, version: 1, lastBookingRef: null, lastPreview: null, lastDirection: null, lastAt: null, updatedAt: ago(0), ...o,
  });
  const m = (dir: "in" | "out", preview: string, min: number, staff = false): WaMessage =>
    ({ id: `${dir}${min}${preview.length}`, direction: dir, kind: dir === "in" ? "text" : "interactive", preview, status: dir === "in" ? "received" : "read", error: null, staff, at: ago(min) });
  const msgs: Record<string, WaMessage[]> = {
    w1: [m("in", "Hola! Llego a Ezeiza mañana 06:40 en el AR1303, voy a Palermo, somos 2 con 2 valijas", 42),
         m("out", "¿Cuál es la dirección o el hotel en *Palermo*?", 42), m("in", "Honduras 5600", 41),
         m("out", "*Revisá tu viaje* 📝\n\n🛬 EZE → Honduras 5600 (Palermo)\n🗓️ sáb 28 nov · 07:40\n💰 USD 30,00 (DEMO)\n[✅ Confirmar] [✏️ Cambiar] [👤 Hablar c/ alguien]", 41),
         m("in", "▸ ✅ Confirmar", 40), m("out", "✅ *Recibimos tu solicitud STT-DEM001*", 39)],
    w2: [m("in", "Hi, we are 9 people with lots of luggage going to AEP on Sunday", 12),
         m("out", "A team member will sort out this group and luggage — I've let them know 👤", 12), m("in", "Thanks! how much would it be?", 6)],
    w3: [m("out", "🚕 *Nueva oferta STT-DEM004*\n🛬 EZE (AA997) → Puerto Madero\n💰 Ganás *USD 24,00*\n[✅ Aceptar] [❌ Rechazar]", 20), m("in", "▸ ✅ Aceptar", 19),
         m("out", "✅ ¡El viaje STT-DEM004 es tuyo!", 19)],
  };
  const last = (id: string) => { const x = msgs[id].at(-1)!; return { lastPreview: x.preview, lastDirection: x.direction, lastAt: x.at }; };
  const convs = [
    conv("w1", "Emma Wilson", "447700900001", { lastBookingRef: "STT-DEM001", locale: "en", ...last("w1") }),
    conv("w2", "Tom Baker", "447700900777", { needsStaff: true, step: "handoff", locale: "en", ...last("w2") }),
    conv("w3", "Diego Romero", "5491100000003", { kind: "driver", ...last("w3") }),
  ];
  return { convs, msgs };
}

// --- live (Supabase) ----------------------------------------------------------------------------
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelize<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) as T;
}

class SupabaseBackend implements Backend {
  mode = "live" as const;
  private sb: SupabaseClient;
  constructor(private url: string, private anonKey: string) {
    this.sb = createClient(url, anonKey);
  }
  async api<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.url}/functions/v1/api${path}`, {
      method,
      headers: {
        "content-type": "application/json", apikey: this.anonKey, authorization: `Bearer ${this.anonKey}`,
        "x-session-id": guestSessionId(), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parse<T>(res);
  }
  async dispatchRows(fromIso: string, toIso: string) {
    const { data, error } = await this.sb.from("dispatch_booking_rows").select("*")
      .gte("agreed_pickup_at", fromIso).lt("agreed_pickup_at", toIso).order("agreed_pickup_at");
    if (error) throw error;
    return (data ?? []).map((r) => camelize<DispatchRow>(r));
  }
  async tripEvents(id: string) {
    const { data, error } = await this.sb.from("trip_events").select("*").eq("booking_id", id).order("created_at");
    if (error) throw error;
    return (data ?? []).map((e) => ({
      bookingId: e.booking_id, kind: e.kind, fromValue: e.from_value, toValue: e.to_value,
      actor: e.actor_id ? "staff" : (e.source ?? "system"), at: e.created_at, payload: e.payload,
    }));
  }
  async drivers() {
    const { data, error } = await this.sb.from("drivers").select("id, full_name, whatsapp_e164, approval_status, active").order("full_name");
    if (error) throw error;
    return (data ?? []).map((d) => ({ id: d.id, fullName: d.full_name, whatsappE164: d.whatsapp_e164, approvalStatus: d.approval_status, active: d.active, vehicleId: null }));
  }
  async staffSession() {
    const { data } = await this.sb.auth.getSession();
    const email = data.session?.user.email;
    return email ? { email, label: email } : null;
  }
  async signIn(email: string, password: string) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { email: data.user.email!, label: data.user.email! };
  }
  async signInDemo(): Promise<StaffSession> {
    throw new Error("Demo sign-in is not available in live mode");
  }
  async signOut() {
    await this.sb.auth.signOut();
  }
  async staffAuthHeader(): Promise<Record<string, string>> {
    const { data } = await this.sb.auth.getSession();
    return data.session ? { authorization: `Bearer ${data.session.access_token}` } : {};
  }

  /** Call a database command; business errors come back as CommandError(code). */
  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new CommandError(error.code === "P0001" ? error.message : error.code || "db_error", error.hint || error.message);
    return data as T;
  }
  async driverBoard() {
    const { data, error } = await this.sb.from("dispatch_driver_board").select("*").order("full_name");
    if (error) throw error;
    return (data ?? []).map((r) => camelize<BoardRow>(r));
  }
  async assign(bookingId: string, driverId: string, version: number, reason?: string) {
    await this.rpc("dispatch_assign", { p_booking: bookingId, p_driver: driverId, p_expected_version: version, p_reason: reason ?? null });
  }
  async offer(bookingId: string, version: number, groupSize: number, driverIds?: string[]) {
    return this.rpc<{ offered: number; expires_at: string }>("dispatch_offer", {
      p_booking: bookingId, p_expected_version: version, p_group_size: groupSize, p_driver_ids: driverIds ?? null,
    });
  }
  async release(bookingId: string, version: number, reason: string) {
    await this.rpc("dispatch_release", { p_booking: bookingId, p_expected_version: version, p_reason: reason });
  }
  async cancel(bookingId: string, version: number, reason: string) {
    await this.rpc("dispatch_cancel", { p_booking: bookingId, p_expected_version: version, p_reason: reason });
  }
  subscribe(onChange: (table: string) => void) {
    const ch = this.sb.channel(`live-${Math.random().toString(36).slice(2)}`);
    for (const table of ["driver_locations", "bookings", "assignments", "booking_offers", "wa_conversations", "wa_messages"]) {
      ch.on("postgres_changes" as never, { event: "*", schema: "public", table } as never, () => onChange(table));
    }
    ch.subscribe();
    return () => { this.sb.removeChannel(ch); };
  }
  async driverMe() { return this.rpc<DriverMe>("driver_me"); }
  async setShift(on: boolean) { await this.rpc("driver_set_shift", { p_on: on }); }
  async reportLocation(p: { lat: number; lng: number; accuracy?: number | null; heading?: number | null; speed?: number | null; at: string }) {
    await this.rpc("driver_report_location", {
      p_lat: p.lat, p_lng: p.lng, p_accuracy: p.accuracy ?? null, p_heading: p.heading ?? null, p_speed: p.speed ?? null, p_recorded_at: p.at,
    });
  }
  async driverOffers() { return this.rpc<DriverOffer[]>("driver_offers"); }
  async respondOffer(offerId: string, accept: boolean) { return this.rpc<{ outcome: string }>("driver_respond_offer", { p_offer: offerId, p_accept: accept }); }
  async driverJobs() { return this.rpc<DriverJob[]>("driver_jobs"); }
  async progress(assignmentId: string, stage: TripStage, version: number) {
    await this.rpc("driver_trip_progress", { p_assignment: assignmentId, p_stage: stage, p_expected_version: version });
  }
  async jobBoard() { return this.rpc<JobBoard>("driver_board"); }
  async claim(bookingId: string) { return this.rpc<{ outcome: string }>("driver_claim", { p_booking: bookingId }); }
  async giveBack(assignmentId: string, reason?: string) {
    return this.rpc<{ outcome: string; on_board: boolean }>("driver_release_claim", { p_assignment: assignmentId, p_reason: reason ?? null });
  }
  async boardAction(bookingId: string, action: "hold" | "publish" | "auto", version: number) {
    await this.rpc("dispatch_board", { p_booking: bookingId, p_action: action, p_expected_version: version });
  }
  async waConversations(): Promise<WaConversation[]> {
    const { data, error } = await this.sb.from("dispatch_wa_inbox").select("*").order("updated_at", { ascending: false }).limit(150);
    if (error) throw new CommandError(error.message);
    // deno-lint-ignore no-explicit-any
    return (data ?? []).map((r: any) => ({
      id: r.id, waId: r.wa_id, phone: r.phone_e164, name: r.profile_name, kind: r.kind, locale: r.locale, step: r.step,
      needsStaff: r.needs_staff, handoffOwner: r.handoff_owner, handledByMe: !!r.handled_by_me, windowOpen: !!r.window_open, version: r.version,
      lastBookingRef: r.last_booking_reference, lastPreview: r.last_preview, lastDirection: r.last_direction, lastAt: r.last_message_at, updatedAt: r.updated_at,
    }));
  }
  async waMessages(conversationId: string): Promise<WaMessage[]> {
    const { data, error } = await this.sb.from("wa_messages").select("id, direction, kind, preview, status, error, sent_by, created_at")
      .eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(300);
    if (error) throw new CommandError(error.message);
    // deno-lint-ignore no-explicit-any
    return (data ?? []).map((r: any) => ({ id: r.id, direction: r.direction, kind: r.kind, preview: r.preview, status: r.status, error: r.error, staff: !!r.sent_by, at: r.created_at }));
  }
  async waTakeover(conversationId: string, take: boolean) { await this.rpc("dispatch_wa_takeover", { p_conversation: conversationId, p_take: take }); }
  async waSend(conversationId: string, text: string) {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) throw new CommandError("unauthenticated");
    const res = await fetch(`${this.url}/functions/v1/whatsapp/staff-send`, {
      method: "POST", headers: { apikey: this.anonKey, authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new CommandError(body?.error?.code ?? "send_failed", body?.error?.message);
  }
  async radioToken() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) throw new CommandError("unauthenticated");
    const res = await fetch(`${this.url}/functions/v1/radio/token`, {
      method: "POST", headers: { apikey: this.anonKey, authorization: `Bearer ${data.session.access_token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new CommandError(body?.error?.code ?? "radio_error", body?.error?.message);
    return body;
  }
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const backend: Backend = url && key ? new SupabaseBackend(url, key) : new DemoBackend();

export type { BookingStatusView };
