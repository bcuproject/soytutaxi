import { describe, expect, it } from "vitest";
import { aeroDataBox, parseBoard, parseFlight, type FlightProvider } from "@shared/flights/aerodatabox.ts";
import { board, myFlights, type FlightCacheDb } from "@shared/flights/service.ts";

// Shapes follow AeroDataBox's FIDS (withLeg=true) and flight-status contracts.
const leg = (o: Record<string, unknown>) => o;
const FIDS = {
  arrivals: [
    { number: "AR 1303", status: "Approaching", codeshareStatus: "IsOperator", isCargo: false, airline: { name: "Aerolineas Argentinas", iata: "AR" },
      departure: leg({ airport: { iata: "MDZ", name: "Mendoza", municipalityName: "Mendoza" }, scheduledTime: { utc: "2026-11-28 08:00Z", local: "2026-11-28 05:00-03:00" }, quality: ["Basic"] }),
      arrival: leg({ airport: { iata: "EZE", name: "Ezeiza" }, scheduledTime: { utc: "2026-11-28 10:00Z", local: "2026-11-28 07:00-03:00" },
        revisedTime: { utc: "2026-11-28 10:25Z", local: "2026-11-28 07:25-03:00" }, terminal: "A", baggageBelt: "5", quality: ["Basic", "Live"] }) },
    { number: "LA 8020", status: "Expected", codeshareStatus: "IsCodeshared", isCargo: false, airline: { name: "LATAM" },
      departure: leg({ airport: { iata: "MDZ", name: "Mendoza" }, scheduledTime: { utc: "2026-11-28 08:00Z", local: "x" }, quality: [] }),
      arrival: leg({ airport: { iata: "EZE", name: "Ezeiza" }, scheduledTime: { utc: "2026-11-28 10:00Z", local: "x" }, quality: [] }) },
    { number: "LH 510", status: "Expected", codeshareStatus: "IsOperator", isCargo: true, airline: { name: "Lufthansa Cargo" },
      departure: leg({ airport: { iata: "FRA", name: "Frankfurt" }, scheduledTime: { utc: "2026-11-28 07:00Z", local: "x" }, quality: [] }),
      arrival: leg({ airport: { iata: "EZE", name: "Ezeiza" }, scheduledTime: { utc: "2026-11-28 09:00Z", local: "x" }, quality: [] }) },
    { number: "IB 6845", status: "Arrived", codeshareStatus: "IsOperator", isCargo: false, airline: { name: "Iberia" },
      departure: leg({ airport: { iata: "MAD", name: "Madrid-Barajas", municipalityName: "Madrid" }, scheduledTime: { utc: "2026-11-27 23:50Z", local: "x" }, quality: [] }),
      arrival: leg({ airport: { iata: "EZE", name: "Ezeiza" }, scheduledTime: { utc: "2026-11-28 09:30Z", local: "x" }, runwayTime: { utc: "2026-11-28 09:12Z", local: "x" }, terminal: "A", quality: [] }) },
  ],
};

describe("AeroDataBox format", () => {
  it("normalises arrivals: drops codeshares and cargo, keeps times in UTC, maps status", () => {
    const b = parseBoard(FIDS, "arr");
    expect(b.map((f) => f.number)).toEqual(["IB 6845", "AR 1303"]);
    expect(b[1]).toMatchObject({ airline: "Aerolineas Argentinas", other: { iata: "MDZ", city: "Mendoza" }, status: "approaching",
      scheduled: "2026-11-28T10:00:00.000Z", estimated: "2026-11-28T10:25:00.000Z", terminal: "A", belt: "5", actual: null });
    expect(b[0]).toMatchObject({ status: "landed", actual: "2026-11-28T09:12:00.000Z", other: { city: "Madrid" } });
    expect(parseBoard({}, "dep")).toEqual([]);
  });

  it("flight status picks the arrival leg data", () => {
    const f = parseFlight([{ ...FIDS.arrivals[0], lastUpdatedUtc: "x" }]);
    expect(f[0]).toMatchObject({ number: "AR 1303", airport: "EZE", date: "2026-11-28", status: "approaching" });
    expect(parseFlight(null)).toEqual([]);
  });

  it("calls API.Market or RapidAPI with the right host, headers and query", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return new Response(JSON.stringify(FIDS), { status: 200 }); }) as unknown as typeof fetch;
    await aeroDataBox({ key: "k1", via: "apimarket" }, fake).board("EZE", "arr", -60, 480);
    await aeroDataBox({ key: "k2", via: "rapidapi" }, fake).flight("AR1303", "2026-11-28");
    expect(calls[0].url).toMatch(/^https:\/\/prod\.api\.market\/api\/v1\/aedbx\/aerodatabox\/flights\/airports\/iata\/EZE\?offsetMinutes=-60&durationMinutes=480&direction=Arrival&withLeg=true&withCancelled=true&withCodeshared=false&withCargo=false/);
    expect(calls[0].headers["x-api-market-key"]).toBe("k1");
    expect(calls[1].url).toMatch(/^https:\/\/aerodatabox\.p\.rapidapi\.com\/flights\/number\/AR1303\/2026-11-28\?dateLocalRole=Arrival/);
    expect(calls[1].headers).toMatchObject({ "x-rapidapi-key": "k2", "x-rapidapi-host": "aerodatabox.p.rapidapi.com" });
  });
});

function memCache(): FlightCacheDb & { store: Map<string, { payload: unknown; fetchedAt: string; expiresAt: string }> } {
  const store = new Map<string, { payload: unknown; fetchedAt: string; expiresAt: string }>();
  return { store, async get(k) { return store.get(k) ?? null; }, async put(k, payload, expiresAt) { store.set(k, { payload, fetchedAt: new Date().toISOString(), expiresAt }); } };
}

describe("flight service", () => {
  const T0 = new Date("2026-11-28T08:00:00Z");
  let calls = 0, fail = false;
  const provider: FlightProvider = {
    async board(iata, dir) { calls++; if (fail) throw new Error("boom"); return parseBoard(FIDS, dir).map((f) => ({ ...f, number: `${iata} ${f.number}` })); },
    async flight(number) { calls++; if (fail) throw new Error("boom"); return parseFlight([{ ...FIDS.arrivals[0], number }]); },
  };

  it("shares one cached board for 5 minutes and serves the last copy if the provider fails", async () => {
    const db = memCache(); calls = 0; fail = false;
    const a = await board(db, provider, "EZE", "arr", T0);
    await board(db, provider, "EZE", "arr", new Date(T0.getTime() + 4 * 60_000));
    expect(calls).toBe(1);
    expect(a.flights).toHaveLength(2);
    fail = true;
    const stale = await board(db, provider, "EZE", "arr", new Date(T0.getTime() + 6 * 60_000));
    expect(stale).toMatchObject({ stale: true, error: "provider_unavailable" });
    expect(stale.flights).toHaveLength(2);
    expect((await board(db, provider, "AEP", "dep", T0)).error).toBe("provider_unavailable");
    expect((await board(db, null, "EZE", "arr", T0)).error).toBe("flights_not_configured");
    await expect(board(db, provider, "JFK", "arr", T0)).rejects.toThrow("invalid_airport");
  });

  it("my flights: only upcoming arrivals with a flight number, with the landing shift in minutes", async () => {
    const db = memCache(); calls = 0; fail = false;
    const jobs = [
      { reference: "STT-A", direction: "from_airport" as const, airport: "EZE", flight: "AR1303", flightDate: "2026-11-28", pickupAt: "2026-11-28T11:00:00Z", state: "confirmed" },
      { reference: "STT-B", direction: "to_airport" as const, airport: "EZE", flight: null, flightDate: null, pickupAt: "2026-11-28T12:00:00Z", state: "confirmed" },
      { reference: "STT-C", direction: "from_airport" as const, airport: "AEP", flight: "LA4521", flightDate: "2026-12-05", pickupAt: "2026-12-05T12:00:00Z", state: "confirmed" },
      { reference: "STT-D", direction: "from_airport" as const, airport: "EZE", flight: "AR1", flightDate: "2026-11-28", pickupAt: "2026-11-28T11:00:00Z", state: "cancelled" },
    ];
    const r = await myFlights(db, provider, jobs, T0);
    expect(r.map((x) => x.reference)).toEqual(["STT-A"]);
    expect(r[0]).toMatchObject({ flight: "AR1303", shiftMinutes: 25 });
    expect(r[0].info).toMatchObject({ terminal: "A", belt: "5", status: "approaching" });
    await myFlights(db, provider, jobs, new Date(T0.getTime() + 2 * 60_000));
    expect(calls).toBe(1);                           // cached 3 min near landing
    expect((await myFlights(db, null, jobs, T0))[0].error).toBe("flights_not_configured");
  });
});
