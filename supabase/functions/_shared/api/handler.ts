// HTTP adapter for the public booking API. Framework-free: takes a Request, returns a Response.
// Runs in the `api` Edge Function (Deno) and, in demo mode, in the browser against MemoryStore.

import { canonicalJson, deriveStatusToken, randomId, sessionHash, sha256Hex } from "../domain/crypto.ts";
import { computeQuote } from "../domain/quote.ts";
import { addMinutes } from "../domain/time.ts";
import type { BookingSource, ContactInput, JourneyInput, Locale, OperatorConfig, PaymentMode } from "../domain/types.ts";
import { ApiError, type Actor, type Store } from "./store.ts";

export interface HandlerContext {
  store: Store;
  /** Secret for deriving status tokens. Must be set per environment. */
  statusTokenSecret: string;
  operatorSlug: string;
  /** Base URL of the passenger front end, used to build status links. */
  publicAppUrl: string;
  now?: () => Date;
  allowedOrigins?: string[];
  rateLimiter?: RateLimiter;
}

// --- rate limiting (per isolate, best effort; put a gateway limit in front in production) ----------
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number) {}
  allow(key: string, nowMs: number): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}

const SESSION_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REF_RE = /^STT-[A-Z0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cors(req: Request, ctx: HandlerContext): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ctx.allowedOrigins ?? ["*"];
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return {
    ...(allow ? { "access-control-allow-origin": allow } : {}),
    "access-control-allow-headers": "authorization, content-type, idempotency-key, x-session-id, x-status-token, x-request-id, apikey, x-client-info",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) throw new ApiError(400, "content_type_must_be_json");
  const text = await req.text();
  if (text.length > 20_000) throw new ApiError(400, "body_too_large");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "malformed_json");
  }
}

function requireSession(req: Request): string {
  const s = req.headers.get("x-session-id") ?? "";
  if (!SESSION_RE.test(s)) throw new ApiError(400, "session_id_required", "X-Session-Id header (16–128 url-safe chars) is required.");
  return s;
}

async function optionalActor(req: Request, ctx: HandlerContext, cfg: OperatorConfig): Promise<Actor | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const actor = await ctx.store.resolveActor(m[1], cfg.operatorId);
  return actor; // null for anon-key bearers (passenger web) — treated as public
}

function isDispatcher(actor: Actor | null): boolean {
  return !!actor && actor.roles.some((r) => r === "admin" || r === "dispatcher" || r === "agent");   // booking-desk agents take bookings too
}

async function loadCfg(ctx: HandlerContext): Promise<OperatorConfig> {
  const cfg = await ctx.store.loadConfig(ctx.operatorSlug);
  if (!cfg) throw new ApiError(503, "operator_not_configured");
  return cfg;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
}

function parseJourney(body: Record<string, unknown>): JourneyInput {
  const place = (body.place ?? {}) as Record<string, unknown>;
  return {
    direction: body.direction as JourneyInput["direction"],
    airport: String(body.airport ?? ""),
    zoneCode: String(body.zoneCode ?? ""),
    place: {
      text: String(place.text ?? ""),
      lat: place.lat === undefined || place.lat === null ? null : num(place.lat),
      lng: place.lng === undefined || place.lng === null ? null : num(place.lng),
    },
    date: String(body.date ?? ""),
    time: String(body.time ?? ""),
    flightDesignator: body.flightDesignator ? String(body.flightDesignator) : null,
    passengers: num(body.passengers),
    largeBags: num(body.largeBags ?? 0),
    carryOn: num(body.carryOn ?? 0),
    vehicleClass: body.vehicleClass ? String(body.vehicleClass) : null,
    locale: (body.locale === "en" ? "en" : "es-AR") as Locale,
  };
}

// --- routes ------------------------------------------------------------------------------------

async function getConfig(ctx: HandlerContext) {
  const cfg = await loadCfg(ctx);
  const p = cfg.policy.config;
  return {
    operator: { slug: cfg.slug, name: cfg.name, timezone: cfg.timezone, demoMode: cfg.demoMode },
    vehicleClasses: cfg.vehicleClasses.filter((v) => v.active).sort((a, b) => a.sortOrder - b.sortOrder),
    airports: cfg.airports.filter((a) => a.active).map(({ id: _id, ...a }) => a),
    zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name })),
    policy: {
      version: cfg.policy.version, isDemo: cfg.policy.isDemo,
      leadTimeMinutes: p.lead_time_minutes, maxAdvanceDays: p.max_advance_days,
      quoteExpiryMinutes: p.quote_expiry_minutes, allowedPaymentModes: p.allowed_payment_modes,
      arrivalBufferMinutes: p.arrival_buffer_minutes, cancellation: p.cancellation, waiting: p.waiting,
      turnaroundMinutes: p.turnaround_minutes, escalation: p.escalation,
    },
  };
}

async function postQuote(req: Request, ctx: HandlerContext, now: Date) {
  const session = requireSession(req);
  const body = await readJson(req);
  const cfg = await loadCfg(ctx);
  const actor = await optionalActor(req, ctx, cfg);
  const source: BookingSource = isDispatcher(actor) ? ((body.source === "phone" ? "phone" : "staff")) : "web";

  const input = parseJourney(body);
  const result = computeQuote(input, cfg, { now, allowMissingFlight: isDispatcher(actor) });
  if (result.kind === "invalid") {
    throw new ApiError(422, "invalid_journey", "The journey could not be quoted.", result.errors, { vehicleOptions: result.options ?? [] });
  }

  const expiresAt = addMinutes(now, cfg.policy.config.quote_expiry_minutes).toISOString();
  const { id } = await ctx.store.insertQuote({
    operatorId: cfg.operatorId,
    sessionHash: await sessionHash(actor ? `actor:${actor.userId}:${session}` : session),
    source,
    kind: result.kind,
    journey: result.journey,
    vehicleClass: result.vehicleClass,
    fare: result.kind === "priced" ? result.fare : null,
    policyId: cfg.policy.id,
    manualReasons: result.kind === "manual" ? result.reasons : [],
    expiresAt,
  });

  return {
    quoteId: id,
    kind: result.kind,
    expiresAt,
    vehicleClass: result.vehicleClass,
    vehicleOptions: result.options,
    fare: result.kind === "priced" ? result.fare : null,
    chargeCurrency: result.kind === "priced" ? result.fare.currency : null,
    manualReasons: result.kind === "manual" ? result.reasons : [],
    review: result.journey,
    policyVersion: cfg.policy.version,
    isDemo: cfg.demoMode || cfg.policy.isDemo,
  };
}

async function postBooking(req: Request, ctx: HandlerContext, requestId: string) {
  const session = requireSession(req);
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new ApiError(400, "idempotency_key_required");
  const body = await readJson(req);
  const cfg = await loadCfg(ctx);
  const actor = await optionalActor(req, ctx, cfg);

  const quoteId = String(body.quoteId ?? "");
  if (!UUID_RE.test(quoteId)) throw new ApiError(400, "invalid_quote_id");

  const c = (body.contact ?? {}) as Record<string, unknown>;
  const contact: ContactInput = {
    name: String(c.name ?? "").trim(),
    phone: c.phone ? String(c.phone).replace(/[\s()-]/g, "") : null,
    email: c.email ? String(c.email).trim().toLowerCase() : null,
    locale: c.locale === "en" ? "en" : "es-AR",
  };
  const fields: { field: string; code: string }[] = [];
  if (contact.name.length < 2 || contact.name.length > 120) fields.push({ field: "contact.name", code: "required" });
  if (contact.phone && !PHONE_RE.test(contact.phone)) fields.push({ field: "contact.phone", code: "invalid_phone" });
  if (contact.email && !EMAIL_RE.test(contact.email)) fields.push({ field: "contact.email", code: "invalid_email" });
  if (!contact.phone && !contact.email) fields.push({ field: "contact.phone", code: "contact_unreachable" });

  const paymentMode = String(body.paymentMode ?? "") as PaymentMode;
  if (!["prepaid", "pay_on_pickup_cash", "pay_on_pickup_card"].includes(paymentMode)) fields.push({ field: "paymentMode", code: "invalid" });
  else if (!cfg.policy.config.allowed_payment_modes.includes(paymentMode)) fields.push({ field: "paymentMode", code: "payment_mode_not_allowed" });

  const notes = body.notes ? String(body.notes).slice(0, 1000) : null;
  const flightExceptionReason = body.flightExceptionReason ? String(body.flightExceptionReason).slice(0, 300) : null;
  if (flightExceptionReason && !isDispatcher(actor)) throw new ApiError(403, "flight_exception_not_permitted");
  if (fields.length) throw new ApiError(422, "invalid_booking", "Please correct the highlighted fields.", fields);

  const requestHash = await sha256Hex(canonicalJson({ quoteId, contact, paymentMode, notes, flightExceptionReason }));
  const token = await deriveStatusToken(ctx.statusTokenSecret, cfg.operatorId, idempotencyKey);

  const result = await ctx.store.createBooking({
    operatorId: cfg.operatorId,
    quoteId,
    sessionHash: await sessionHash(actor ? `actor:${actor.userId}:${session}` : session),
    idempotencyKey,
    requestHash,
    contact,
    paymentMode,
    notes,
    statusTokenHash: await sha256Hex(token),
    actorId: actor?.userId ?? null,
    flightExceptionReason,
    requestId,
  });

  const statusUrl = `${ctx.publicAppUrl.replace(/\/$/, "")}/reserva/${result.reference}?t=${token}`;
  return {
    status: result.replay ? 200 : 201,
    body: { reference: result.reference, statusUrl, statusToken: token, bookingState: result.state, replay: result.replay },
  };
}

async function getBooking(req: Request, ctx: HandlerContext, reference: string, url: URL) {
  const token = req.headers.get("x-status-token") ?? url.searchParams.get("t") ?? "";
  if (!REF_RE.test(reference) || token.length < 20) throw new ApiError(404, "booking_not_found");
  const view = await ctx.store.getBookingStatus(reference, await sha256Hex(token));
  if (!view) throw new ApiError(404, "booking_not_found");
  return view;
}

// --- entry point -------------------------------------------------------------------------------

export async function handle(req: Request, ctx: HandlerContext): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? randomId();
  const headers = { ...cors(req, ctx), "x-request-id": requestId };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const now = (ctx.now ?? (() => new Date()))();
  const url = new URL(req.url);
  // Accept /api/..., /functions/v1/api/... and /api/api/... (Supabase prefixes the function name).
  const idx = url.pathname.lastIndexOf("/api/");
  const path = idx >= 0 ? url.pathname.slice(idx + 4) : url.pathname;

  try {
    if (ctx.rateLimiter) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
      const key = `${ip}:${req.headers.get("x-session-id") ?? ""}`;
      if (!ctx.rateLimiter.allow(key, now.getTime())) throw new ApiError(429, "rate_limited");
    }

    if (req.method === "GET" && path === "/config") return json(200, await getConfig(ctx), headers);
    if (req.method === "POST" && path === "/quotes") return json(201, await postQuote(req, ctx, now), headers);
    if (req.method === "POST" && path === "/bookings") {
      const r = await postBooking(req, ctx, requestId);
      return json(r.status, r.body, headers);
    }
    const m = /^\/bookings\/([A-Za-z0-9-]+)$/.exec(path);
    if (req.method === "GET" && m) return json(200, await getBooking(req, ctx, m[1].toUpperCase(), url), headers);

    throw new ApiError(404, "not_found");
  } catch (e) {
    if (e instanceof ApiError) {
      return json(e.status, { error: { code: e.code, message: e.message, requestId, fields: e.fields, ...e.extra } }, headers);
    }
    // Never leak internals; log identifiers only.
    console.error(JSON.stringify({ level: "error", requestId, path, error: String((e as Error)?.message ?? e).slice(0, 300) }));
    return json(500, { error: { code: "internal_error", message: "Unexpected error", requestId } }, headers);
  }
}
