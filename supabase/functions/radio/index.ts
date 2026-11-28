// Supabase Edge Function `radio` — walkie-talkie access. POST /radio/token with the caller's
// Supabase access token. Dispatchers/admins and approved, on-shift drivers get a LiveKit token for
// the shared dispatch channel. Secrets: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2";
import { secretSource } from "../_shared/secrets.ts";
import { mintLiveKitToken, RADIO_ROOM } from "../_shared/domain/livekit.ts";

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
const SEC = secretSource(db, (k) => Deno.env.get(k) ?? "");
const OPERATOR = Deno.env.get("OPERATOR_SLUG") ?? "soytutaxi";
const CORS = {
  "access-control-allow-origin": Deno.env.get("ALLOWED_ORIGINS") ?? "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/token")) return json(404, { error: { code: "not_found" } });

  await SEC.refresh();
  const url = SEC.get("LIVEKIT_URL");
  const apiKey = SEC.get("LIVEKIT_API_KEY");
  const apiSecret = SEC.get("LIVEKIT_API_SECRET");
  if (!url || !apiKey || !apiSecret) return json(503, { error: { code: "radio_not_configured", message: "LiveKit secrets are not set." } });

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return json(401, { error: { code: "unauthenticated" } });
  const { data: u } = await db.auth.getUser(bearer);
  if (!u?.user) return json(401, { error: { code: "unauthenticated" } });

  const { data: op } = await db.from("operators").select("id").eq("slug", OPERATOR).single();
  if (!op) return json(503, { error: { code: "operator_not_configured" } });

  const { data: roles } = await db.from("memberships").select("role")
    .eq("operator_id", op.id).eq("user_id", u.user.id).eq("active", true);
  const isDispatch = (roles ?? []).some((r) => r.role === "admin" || r.role === "dispatcher");

  let identity: string, name: string, kind: "dispatch" | "driver";
  if (isDispatch) {
    identity = `staff:${u.user.id}`;
    name = `Despacho (${u.user.email?.split("@")[0] ?? "staff"})`;
    kind = "dispatch";
  } else {
    const { data: d } = await db.from("drivers").select("id, full_name, on_shift")
      .eq("operator_id", op.id).eq("auth_user_id", u.user.id).eq("active", true).eq("approval_status", "approved").maybeSingle();
    if (!d) return json(403, { error: { code: "forbidden" } });
    if (!d.on_shift) return json(409, { error: { code: "off_shift", message: "Start your shift to use the radio." } });
    identity = `driver:${d.id}`;
    name = d.full_name;
    kind = "driver";
  }

  const token = await mintLiveKitToken({
    apiKey, apiSecret, identity, name, room: RADIO_ROOM,
    canPublish: true, ttlSeconds: kind === "dispatch" ? 12 * 3600 : 6 * 3600, metadata: { kind },
  });
  return json(200, { url, token, room: RADIO_ROOM, identity, name, kind });
});
