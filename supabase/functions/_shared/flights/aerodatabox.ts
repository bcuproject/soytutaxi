// Flight data from AeroDataBox (via API.Market or RapidAPI), normalised to what the driver app needs.
// Only this file knows the provider's format; swap it to change providers.

export type FlightStatus =
  | "scheduled" | "delayed" | "boarding" | "departed" | "en_route" | "approaching" | "landed" | "cancelled" | "diverted" | "unknown";

export interface BoardFlight {
  number: string;                 // "AR 1303"
  airline: string;
  other: { iata: string | null; city: string };   // origin for arrivals, destination for departures
  scheduled: string;              // ISO UTC at this airport
  estimated: string | null;       // revised/predicted
  actual: string | null;          // runway time
  status: FlightStatus;
  terminal: string | null;
  gate: string | null;
  belt: string | null;
}

export interface FlightInfo extends BoardFlight {
  date: string;                   // local date of arrival at `airport`
  airport: string;                // arrival airport IATA
}

export interface FlightProvider {
  board(iata: string, dir: "arr" | "dep", offsetMinutes: number, durationMinutes: number): Promise<BoardFlight[]>;
  flight(number: string, localDate: string): Promise<FlightInfo[]>;
}

const STATUS: Record<string, FlightStatus> = {
  Expected: "scheduled", CheckIn: "scheduled", Unknown: "unknown", Boarding: "boarding", GateClosed: "boarding",
  Departed: "departed", EnRoute: "en_route", Delayed: "delayed", Approaching: "approaching", Arrived: "landed",
  Canceled: "cancelled", CanceledUncertain: "cancelled", Diverted: "diverted",
};

// deno-lint-ignore no-explicit-any
type Any = any;
const utc = (t: Any): string | null => (t?.utc ? new Date(String(t.utc).replace(" ", "T").replace(/Z?$/, "Z")).toISOString() : null);

/** One leg of a flight seen from `side` (the movement at our airport) and `other` (the far end). */
export function normalise(f: Any, side: Any, other: Any): BoardFlight | null {
  const scheduled = utc(side?.scheduledTime);
  if (!f?.number || !scheduled) return null;
  const estimated = utc(side?.revisedTime) ?? utc(side?.predictedTime);
  return {
    number: String(f.number).trim(),
    airline: String(f.airline?.name ?? "").trim(),
    other: { iata: other?.airport?.iata ?? null, city: String(other?.airport?.municipalityName ?? other?.airport?.shortName ?? other?.airport?.name ?? "") },
    scheduled,
    estimated: estimated && estimated !== scheduled ? estimated : null,
    actual: utc(side?.runwayTime),
    status: STATUS[String(f.status)] ?? "unknown",
    terminal: side?.terminal ?? null,
    gate: side?.gate ?? null,
    belt: side?.baggageBelt ?? null,
  };
}

export function parseBoard(body: Any, dir: "arr" | "dep"): BoardFlight[] {
  const list: Any[] = (dir === "arr" ? body?.arrivals : body?.departures) ?? [];
  return list
    .filter((f) => !f?.isCargo && f?.codeshareStatus !== "IsCodeshared")
    .map((f) => (dir === "arr" ? normalise(f, f.arrival ?? f.movement, f.departure ?? { airport: f.movement?.airport }) : normalise(f, f.departure ?? f.movement, f.arrival ?? { airport: f.movement?.airport })))
    .filter((x): x is BoardFlight => !!x)
    .sort((a, b) => a.scheduled.localeCompare(b.scheduled));
}

export function parseFlight(body: Any): FlightInfo[] {
  return (Array.isArray(body) ? body : []).map((f) => {
    const n = normalise(f, f.arrival, f.departure);
    if (!n) return null;
    const local = String(f.arrival?.scheduledTime?.local ?? "").slice(0, 10);
    return { ...n, airport: f.arrival?.airport?.iata ?? "", date: local };
  }).filter((x): x is FlightInfo => !!x);
}

export function aeroDataBox(cfg: { key: string; via: "apimarket" | "rapidapi" }, fetchImpl: typeof fetch = fetch): FlightProvider {
  const base = cfg.via === "rapidapi" ? "https://aerodatabox.p.rapidapi.com" : "https://prod.api.market/api/v1/aedbx/aerodatabox";
  const headers: Record<string, string> = cfg.via === "rapidapi"
    ? { "x-rapidapi-key": cfg.key, "x-rapidapi-host": "aerodatabox.p.rapidapi.com" }
    : { "x-api-market-key": cfg.key };
  async function get(path: string) {
    const r = await fetchImpl(`${base}${path}`, { headers: { ...headers, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`flights_provider_${r.status}`);
    return await r.json();
  }
  return {
    async board(iata, dir, offsetMinutes, durationMinutes) {
      const q = new URLSearchParams({
        offsetMinutes: String(offsetMinutes), durationMinutes: String(durationMinutes), direction: dir === "arr" ? "Arrival" : "Departure",
        withLeg: "true", withCancelled: "true", withCodeshared: "false", withCargo: "false", withPrivate: "false", withLocation: "false",
      });
      return parseBoard(await get(`/flights/airports/iata/${encodeURIComponent(iata)}?${q}`), dir);
    },
    async flight(number, localDate) {
      const q = new URLSearchParams({ dateLocalRole: "Arrival", withAircraftImage: "false", withLocation: "false" });
      return parseFlight(await get(`/flights/number/${encodeURIComponent(number)}/${localDate}?${q}`));
    },
  };
}
