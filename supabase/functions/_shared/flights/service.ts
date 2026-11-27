// Cached flight data for the driver app. Boards are shared by every driver (one provider call per airport
// and direction every few minutes); flight status is cached per flight and refreshed more often near landing.
import type { BoardFlight, FlightInfo, FlightProvider } from "./aerodatabox.ts";

export interface FlightCacheDb {
  get(key: string): Promise<{ payload: unknown; fetchedAt: string; expiresAt: string } | null>;
  put(key: string, payload: unknown, expiresAt: string): Promise<void>;
}

export const AIRPORTS = ["EZE", "AEP"] as const;
const BOARD_TTL_S = 300;

export interface BoardResult { airport: string; direction: "arr" | "dep"; fetchedAt: string | null; stale: boolean; flights: BoardFlight[]; error?: string }

async function cached<T>(db: FlightCacheDb, key: string, now: Date, ttlS: number, load: () => Promise<T>) {
  const hit = await db.get(key);
  if (hit && new Date(hit.expiresAt) > now) return { value: hit.payload as T, fetchedAt: hit.fetchedAt, stale: false };
  try {
    const value = await load();
    await db.put(key, value, new Date(now.getTime() + ttlS * 1000).toISOString());
    return { value, fetchedAt: now.toISOString(), stale: false };
  } catch (e) {
    if (hit) return { value: hit.payload as T, fetchedAt: hit.fetchedAt, stale: true, error: String((e as Error).message) };
    throw e;
  }
}

export async function board(db: FlightCacheDb, provider: FlightProvider | null, airport: string, direction: "arr" | "dep", now: Date): Promise<BoardResult> {
  if (!(AIRPORTS as readonly string[]).includes(airport)) throw new Error("invalid_airport");
  if (!provider) return { airport, direction, fetchedAt: null, stale: false, flights: [], error: "flights_not_configured" };
  try {
    const r = await cached(db, `board:${airport}:${direction}`, now, BOARD_TTL_S,
      () => provider.board(airport, direction, direction === "arr" ? -60 : -30, 480));
    return { airport, direction, fetchedAt: r.fetchedAt, stale: r.stale, flights: r.value, ...(r.stale ? { error: "provider_unavailable" } : {}) };
  } catch {
    return { airport, direction, fetchedAt: null, stale: false, flights: [], error: "provider_unavailable" };
  }
}

export interface DriverFlightJob {
  reference: string; direction: "from_airport" | "to_airport"; airport: string; flight: string | null;
  flightDate: string | null; pickupAt: string; state: string;
}

export interface MyFlight {
  reference: string; airport: string; pickupAt: string; flight: string; flightDate: string;
  info: FlightInfo | null; fetchedAt: string | null; error?: string;
  /** Minutes the landing moved vs schedule (estimated or actual − scheduled). */
  shiftMinutes: number | null;
}

/** Live status for the driver's own airport pickups (arrivals with a flight number, from 3 h ago to 30 h ahead). */
export async function myFlights(db: FlightCacheDb, provider: FlightProvider | null, jobs: DriverFlightJob[], now: Date): Promise<MyFlight[]> {
  const relevant = jobs.filter((j) => j.direction === "from_airport" && j.flight && j.flightDate && j.state !== "cancelled"
    && new Date(j.pickupAt).getTime() > now.getTime() - 3 * 3600_000 && new Date(j.pickupAt).getTime() < now.getTime() + 30 * 3600_000)
    .sort((a, b) => a.pickupAt.localeCompare(b.pickupAt));
  const out: MyFlight[] = [];
  for (const j of relevant) {
    const base = { reference: j.reference, airport: j.airport, pickupAt: j.pickupAt, flight: j.flight!, flightDate: j.flightDate! };
    if (!provider) { out.push({ ...base, info: null, fetchedAt: null, error: "flights_not_configured", shiftMinutes: null }); continue; }
    const soon = Math.abs(new Date(j.pickupAt).getTime() - now.getTime()) < 6 * 3600_000;
    try {
      const r = await cached(db, `flight:${j.flight}:${j.flightDate}`, now, soon ? 180 : 1800, () => provider.flight(j.flight!, j.flightDate!));
      const legs = r.value as FlightInfo[];
      const info = legs.find((l) => l.airport === j.airport) ?? legs[legs.length - 1] ?? null;
      const moved = info ? (info.actual ?? info.estimated) : null;
      out.push({ ...base, info, fetchedAt: r.fetchedAt, shiftMinutes: info && moved ? Math.round((new Date(moved).getTime() - new Date(info.scheduled).getTime()) / 60000) : null,
        ...(r.stale ? { error: "provider_unavailable" } : !info ? { error: "flight_not_found" } : {}) });
    } catch {
      out.push({ ...base, info: null, fetchedAt: null, error: "provider_unavailable", shiftMinutes: null });
    }
  }
  return out;
}
