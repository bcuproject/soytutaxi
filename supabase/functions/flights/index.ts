// Supabase Edge Function `flights` (deploy with --no-verify-jwt; callers send their Supabase access token).
//   GET /flights/board?airport=EZE|AEP&dir=arr|dep   airport arrivals/departures board (drivers and staff)
//   GET /flights/mine                                live status of the signed-in driver's airport pickups
//   POST /flights/track                              flight tracking pass (pg_cron, x-outbox-key): proposes pickups
// Secrets: FLIGHTS_API_KEY (AeroDataBox) and FLIGHTS_PROVIDER = "apimarket" (default) | "rapidapi".
import { createClient } from "npm:@supabase/supabase-js@2";
import { aeroDataBox } from "../_shared/flights/aerodatabox.ts";
import { board, myFlights, trackFlights, type DriverFlightJob, type FlightCacheDb, type TrackTarget } from "../_shared/flights/service.ts";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const first = Object.values(JSON.parse(keys) as Record<string, string>)[0];
    if (first) return first;
  }
  throw new Error("missing service role / secret key");
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const OPERATOR = Deno.env.get("OPERATOR_SLUG") ?? "soytutaxi";
const KEY = Deno.env.get("FLIGHTS_API_KEY") ?? "";
const provider = KEY ? aeroDataBox({ key: KEY, via: Deno.env.get("FLIGHTS_PROVIDER") === "rapidapi" ? "rapidapi" : "apimarket" }) : null;
const CORS = {
  "access-control-allow-origin": Deno.env.get("ALLOWED_ORIGINS") ?? "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const cache: FlightCacheDb = {
  async get(key) {
    const { data } = await db.from("flight_cache").select("payload, fetched_at, expires_at").eq("key", key).maybeSingle();
    return data ? { payload: data.payload, fetchedAt: data.fetched_at, expiresAt: data.expires_at } : null;
  },
  async put(key, payload, expiresAt) {
    await db.from("flight_cache").upsert({ key, payload, fetched_at: new Date().toISOString(), expires_at: expiresAt });
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname.endsWith("/track")) {
    const { data: ok } = await db.rpc("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" });
    if (!ok) return json(401, { error: { code: "unauthenticated" } });
    const { data: targets, error } = await db.rpc("flight_tracking_targets");
    if (error) return json(500, { error: { code: "internal" } });
    const r = await trackFlights(cache, provider, (targets ?? []) as TrackTarget[], async (id, status, arrival, kind, airport, ambiguous) => {
      const { data, error: e } = await db.rpc("flight_tracking_apply", { p_booking: id, p_status: status, p_arrival: arrival, p_kind: kind,
        p_arrival_airport: airport, p_ambiguous: ambiguous });
      if (e) throw new Error(e.message);
      return data as { outcome: string };
    }, new Date());
    if (r.checked || r.failed) console.log(JSON.stringify({ fn: "flights", track: r }));
    return json(200, r);
  }
  if (req.method !== "GET") return json(405, { error: { code: "method_not_allowed" } });

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return json(401, { error: { code: "unauthenticated" } });
  const { data: u } = await db.auth.getUser(bearer);
  if (!u?.user) return json(401, { error: { code: "unauthenticated" } });
  const { data: op } = await db.from("operators").select("id").eq("slug", OPERATOR).single();
  if (!op) return json(503, { error: { code: "operator_not_configured" } });
  const [{ data: roles }, { data: driver }] = await Promise.all([
    db.from("memberships").select("role").eq("operator_id", op.id).eq("user_id", u.user.id).eq("active", true),
    db.from("drivers").select("id").eq("operator_id", op.id).eq("auth_user_id", u.user.id).eq("active", true).eq("approval_status", "approved").maybeSingle(),
  ]);
  const staff = (roles ?? []).some((r) => ["admin", "dispatcher", "agent"].includes(r.role));
  if (!staff && !driver) return json(403, { error: { code: "forbidden" } });
  const now = new Date();

  if (url.pathname.endsWith("/board")) {
    const airport = (url.searchParams.get("airport") ?? "EZE").toUpperCase();
    const dir = url.searchParams.get("dir") === "dep" ? "dep" : "arr";
    if (!["EZE", "AEP"].includes(airport)) return json(400, { error: { code: "invalid_airport" } });
    return json(200, await board(cache, provider, airport, dir, now));
  }

  if (url.pathname.endsWith("/mine")) {
    if (!driver) return json(200, { flights: [], configured: !!provider });
    const { data: rows } = await db.from("assignments")
      .select("state, bookings!inner(reference, direction, flight_designator, flight_local_arrival_date, agreed_pickup_at, state, airports!inner(iata))")
      .eq("driver_id", driver.id).neq("state", "released");
    // deno-lint-ignore no-explicit-any
    const jobs: DriverFlightJob[] = (rows ?? []).map((r: any) => ({
      reference: r.bookings.reference, direction: r.bookings.direction, airport: r.bookings.airports.iata,
      flight: r.bookings.flight_designator, flightDate: r.bookings.flight_local_arrival_date,
      pickupAt: r.bookings.agreed_pickup_at, state: r.bookings.state,
    }));
    return json(200, { flights: await myFlights(cache, provider, jobs, now), configured: !!provider });
  }
  return json(404, { error: { code: "not_found" } });
});
