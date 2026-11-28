// Supabase Edge Function `payments` (deploy with --no-verify-jwt; every route authenticates itself).
//   POST /payments/checkout  {reference, token}   passenger's status-link token → Mercado Pago checkout URL
//   POST /payments/webhook                         Mercado Pago notification (x-signature, MP_WEBHOOK_SECRET)
//   POST /payments/outbox                          refund worker, called by pg_cron (x-outbox-key)
// Secrets: MP_ACCESS_TOKEN (TEST-… for sandbox), MP_WEBHOOK_SECRET, optional MP_COLLECTOR_ID, PUBLIC_APP_URL.
import { createClient } from "npm:@supabase/supabase-js@2";
import { secretSource } from "../_shared/secrets.ts";
import { ApiError } from "../_shared/api/store.ts";
import { mercadoPago, verifyMpSignature } from "../_shared/payments/mercadopago.ts";
import { checkout, notification, processPaymentJobs, type PayDb } from "../_shared/payments/service.ts";

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
const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const db = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false } });
const SEC = secretSource(db, env);
const CORS = {
  "access-control-allow-origin": env("ALLOWED_ORIGINS") || "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ fn: "payments", ...o }));

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.message && /^[a-z_]+$/.test(error.message)) throw new ApiError(Number(error.details) || 400, error.message, error.hint ?? error.message);
    throw new Error(`${fn}: ${error.message}`);
  }
  return data as T;
}

const payDb: PayDb = {
  checkoutContext: (ref, hash) => rpc("pay_checkout_context", { p_reference: ref, p_token_hash: hash }),
  createAttempt: (b, amount, cur, fare, fareCur, fx, exp) => rpc("pay_attempt_create", { p_booking: b, p_amount: amount, p_currency: cur,
    p_fare_amount: fare, p_fare_currency: fareCur, p_fx: fx, p_expires: exp }),
  attemptReady: async (id, pref, url, ok) => { await rpc("pay_attempt_ready", { p_attempt: id, p_preference: pref, p_url: url, p_ok: ok }); },
  record: (a, p, s, amt, cur, at) => rpc("pay_record", { p_attempt: a, p_provider_payment_id: p, p_status: s, p_amount: amt, p_currency: cur, p_approved_at: at }),
  async inboxClaim(key) {
    const { data: op } = await db.from("operators").select("id").eq("slug", env("OPERATOR_SLUG") || "soytutaxi").single();
    const { data, error } = await db.from("inbox_events").insert({ operator_id: op!.id, provider: "mercadopago", event_key: key }).select("id");
    if (error) return false;
    return !!data?.length;
  },
  inboxDone: async (key) => { await db.from("inbox_events").update({ processed_at: new Date().toISOString() }).eq("provider", "mercadopago").eq("event_key", key); },
  outboxClaim: (limit) => rpc("pay_outbox_claim", { p_limit: limit }),
  outboxFinish: async (job, ok, error, final) => { await rpc("wa_outbox_finish", { p_job: job, p_ok: ok, p_error: error, p_final: final }); },
  refundContext: (id) => rpc("pay_refund_context", { p_refund: id }),
  refundSet: async (id, state, pid, error) => { await rpc("pay_refund_set", { p_refund: id, p_state: state, p_provider_refund_id: pid, p_error: error }); },
};

const deps = {
  db: payDb, log,
  get mp() { const t = SEC.get("MP_ACCESS_TOKEN"); return t ? mercadoPago(t) : null; },
  publicAppUrl: env("PUBLIC_APP_URL") || "https://bcuproject.github.io/soytutaxi",
  notificationUrl: `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/payments/webhook`,
  get collectorId() { return SEC.get("MP_COLLECTOR_ID") || null; },
};

Deno.serve(async (req) => {
  await SEC.refresh();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.endsWith("/checkout")) {
    const body = await req.json().catch(() => ({}));
    try {
      return json(200, await checkout(deps, String(body?.reference ?? ""), String(body?.token ?? "")));
    } catch (e) {
      if (e instanceof ApiError) return json(e.status, { error: { code: e.code } });
      log({ level: "error", where: "checkout", error: String((e as Error).message).slice(0, 200) });
      return json(500, { error: { code: "internal" } });
    }
  }

  if (path.endsWith("/webhook")) {
    const dataId = url.searchParams.get("data.id") ?? url.searchParams.get("id");
    const ok = await verifyMpSignature(req.headers.get("x-signature"), req.headers.get("x-request-id"), dataId, SEC.get("MP_WEBHOOK_SECRET"));
    if (!ok) { log({ level: "warn", msg: "bad signature" }); return json(401, { error: { code: "bad_signature" } }); }
    const body = await req.json().catch(() => ({}));
    try {
      const outcome = await notification(deps, { type: body?.type ?? url.searchParams.get("type"), dataId, requestId: req.headers.get("x-request-id") });
      log({ level: "info", payment: dataId, outcome });
      return json(200, { ok: true });
    } catch (e) {
      log({ level: "error", where: "webhook", error: String((e as Error).message).slice(0, 200) });
      return json(500, { error: { code: "retry" } });          // Mercado Pago retries later
    }
  }

  if (path.endsWith("/outbox")) {
    const ok = await rpc<boolean>("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" }).catch(() => false);
    if (!ok) return json(401, { error: { code: "unauthenticated" } });
    return json(200, await processPaymentJobs(deps));
  }
  return json(404, { error: { code: "not_found" } });
});
