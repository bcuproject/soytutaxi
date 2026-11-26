// Supabase Edge Function `api` — public booking API (POST /api/quotes, POST /api/bookings,
// GET /api/bookings/:ref, GET /api/config). Deploy with --no-verify-jwt: passengers are anonymous;
// staff callers send their Supabase access token and are resolved server-side.

import { handle, RateLimiter } from "../_shared/api/handler.ts";
import { SupabaseStore } from "../_shared/api/supabaseStore.ts";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  // Newer projects expose secret keys as a JSON object.
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const first = Object.values(JSON.parse(keys) as Record<string, string>)[0];
    if (first) return first;
  }
  throw new Error("missing service role / secret key");
}

const url = Deno.env.get("SUPABASE_URL");
if (!url) throw new Error("missing SUPABASE_URL");
const key = serviceKey();
const store = new SupabaseStore(url, key);
const rateLimiter = new RateLimiter(Number(Deno.env.get("RATE_LIMIT_PER_MINUTE") ?? 60), 60_000);
// Dedicated secret recommended; falls back to the server-only key (rotating it invalidates status links).
const statusTokenSecret = Deno.env.get("STATUS_TOKEN_SECRET") ?? `status:${key}`;

Deno.serve((req) =>
  handle(req, {
    store,
    statusTokenSecret,
    operatorSlug: Deno.env.get("OPERATOR_SLUG") ?? "soytutaxi",
    publicAppUrl: Deno.env.get("PUBLIC_APP_URL") ?? req.headers.get("origin") ?? "",
    allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()),
    rateLimiter,
  })
);
