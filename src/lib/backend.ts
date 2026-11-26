// Front-end backend port. DEMO mode runs the real API handler in the browser against MemoryStore;
// LIVE mode calls the `api` Edge Function and reads dispatch data through Supabase with RLS.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handle } from "@shared/api/handler.ts";
import { MemoryStore, type DispatchRow, type MemEvent } from "@shared/api/memoryStore.ts";
import { DEMO_DRIVERS } from "@shared/domain/fixtures.ts";
import type { BookingStatusView } from "@shared/api/store.ts";
import type { Driver } from "@shared/domain/types.ts";

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
}

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
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const backend: Backend = url && key ? new SupabaseBackend(url, key) : new DemoBackend();

export type { BookingStatusView };
