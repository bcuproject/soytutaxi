// WhatsApp voice bot: routing calls to the LiveKit agent (Fish Audio voice, BCU server) and the tools the
// agent may use. The agent never touches the database: every tool call comes back here with a per-call
// token, and quotes/bookings go through the same computeQuote / create_booking_from_quote as the website.
// The caller's phone number always comes from the call record, never from the AI.

import { canonicalJson, deriveStatusToken, hmacBase64Url, sessionHash, sha256Hex } from "../domain/crypto.ts";
import { formatMoney } from "../domain/fare.ts";
import { computeQuote } from "../domain/quote.ts";
import { addMinutes, utcToLocalDate } from "../domain/time.ts";
import type { Direction, Locale, OperatorConfig, PaymentMode } from "../domain/types.ts";
import { ApiError, type Store } from "../api/store.ts";
import type { BookingSummary } from "./engine.ts";
import type { Outbound } from "./meta.ts";

// ------------------------------------------------------------------------------------------ tokens
export const voiceToken = (secret: string, providerCallId: string) => hmacBase64Url(secret, `voice:${providerCallId}`);

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ------------------------------------------------------------------------------------------ LiveKit
const enc = new TextEncoder();
const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Server token for LiveKit's Connector API (room admin + SIP/WhatsApp call grants). */
export async function connectorJwt(apiKey: string, apiSecret: string, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: apiKey, sub: "soytutaxi-webhook", nbf: iat - 5, iat, exp: iat + 600,
    video: { roomCreate: true, roomAdmin: true }, sip: { call: true, admin: true } }));
  const key = await crypto.subtle.importKey("raw", enc.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export interface VoiceBot {
  /** Hand Meta's WebRTC offer to LiveKit's WhatsApp connector, which answers and dispatches the agent. */
  accept(a: { callId: string; sdp: string; room: string; callerPhone: string; attributes: Record<string, string> }): Promise<void>;
  disconnect(callId: string): Promise<void>;
}

export const VOICE_AGENT_NAME = "bcu-taxi";        // the BCU server's LiveKit worker; it routes on bcu_assistant
export const VOICE_ASSISTANT = "soytutaxi";

export function liveKitVoiceBot(cfg: { url: string; apiKey: string; apiSecret: string; phoneNumberId: string; waToken: string },
  fetchImpl: typeof fetch = fetch): VoiceBot {
  const base = cfg.url.replace(/^wss?:/, "https:").replace(/\/$/, "");
  async function call(method: string, body: unknown) {
    const r = await fetchImpl(`${base}/twirp/livekit.Connector/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await connectorJwt(cfg.apiKey, cfg.apiSecret)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`livekit ${method} ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  }
  return {
    async accept(a) {
      await call("AcceptWhatsAppCall", {
        whatsapp_phone_number_id: cfg.phoneNumberId, whatsapp_api_key: cfg.waToken, whatsapp_cloud_api_version: "23.0",
        whatsapp_call_id: a.callId, sdp: { type: "offer", sdp: a.sdp }, room_name: a.room,
        agents: [{ agent_name: VOICE_AGENT_NAME }],
        participant_identity: `caller-${a.callerPhone.replace(/\D/g, "")}`,
        participant_attributes: a.attributes,
      });
    },
    async disconnect(callId) {
      await call("DisconnectWhatsAppCall", { whatsapp_call_id: callId, whatsapp_api_key: cfg.waToken });
    },
  };
}

// ------------------------------------------------------------------------------------------ tools
export interface VoiceCall {
  operatorId: string; providerCallId: string; phone: string; waId: string; name: string | null;
  status: string; handledBy: string; endedAt: string | null; conversationId: string | null;
}

export interface VoiceDeps {
  cfg: OperatorConfig;
  store: Store;
  now: Date;
  secret: string;                  // signs per-call tokens
  statusTokenSecret: string;
  publicAppUrl: string;
  call(providerCallId: string): Promise<VoiceCall | null>;
  bookingsForPhone(phone: string): Promise<BookingSummary[]>;
  note(providerCallId: string, note: string, callback: boolean): Promise<void>;
  /** WhatsApp message to the caller (within the 24 h window the call opened). */
  sendWhatsApp(call: VoiceCall, m: Outbound): Promise<boolean>;
}

export type VoiceResult = { status: number; body: Record<string, unknown> };

const PAY_ES: Record<PaymentMode, [string, string]> = {
  prepaid: ["pago online con link", "online payment link"],
  pay_on_pickup_cash: ["efectivo al chofer", "cash to the driver"],
  pay_on_pickup_card: ["tarjeta al chofer", "card to the driver"],
};

/** "STT-ABC234" → "S T T, A B C 2 3 4" so the voice reads it letter by letter. */
export const spellReference = (ref: string) => {
  const [a, b] = ref.split("-");
  return `${a.split("").join(" ")}, ${(b ?? "").split("").join(" ")}`;
};

function when(iso: string, tz: string, lc: Locale) {
  const l = lc === "en" ? "en-GB" : "es-AR";
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d)}, ${
    new Intl.DateTimeFormat(l, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : NaN);

const PROBLEM: Record<string, [string, string]> = {
  outside_service_area: ["esa zona no está en nuestro servicio", "that area isn't in our service zones"],
  unsupported_airport: ["solo operamos Ezeiza y Aeroparque", "we only serve Ezeiza and Aeroparque"],
  invalid_flight: ["el número de vuelo no parece válido", "the flight number doesn't look valid"],
  required: ["falta un dato", "a detail is missing"],
  invalid_date: ["la fecha no es válida", "the date isn't valid"],
  invalid_time: ["la hora no es válida", "the time isn't valid"],
  invalid_count: ["la cantidad de pasajeros o valijas no es válida", "the number of passengers or bags isn't valid"],
  in_past: ["ese horario ya pasó", "that time has already passed"],
  inside_lead_time: ["necesitamos más anticipación", "we need more notice"],
  too_far_ahead: ["es demasiado adelante", "that's too far ahead"],
  vehicle_not_eligible: ["ese vehículo no alcanza para el grupo", "that vehicle is too small for the group"],
};

export async function voiceTool(deps: VoiceDeps, input: Record<string, unknown>): Promise<VoiceResult> {
  const callId = str(input.callId, 300);
  const token = str(input.token, 200);
  if (!callId || !token || !safeEqual(token, await voiceToken(deps.secret, callId))) return { status: 401, body: { error: { code: "unauthenticated" } } };
  const call = await deps.call(callId);
  if (!call || call.handledBy !== "bot") return { status: 404, body: { error: { code: "call_not_found" } } };
  if (call.endedAt && deps.now.getTime() - new Date(call.endedAt).getTime() > 10 * 60_000) return { status: 410, body: { error: { code: "call_over" } } };
  const cfg = deps.cfg;
  const lang: Locale = input.language === "en" ? "en" : "es-AR";
  const L = (es: string, en: string) => (lang === "en" ? en : es);
  const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>;
  const pc = cfg.policy.config;

  switch (String(input.action)) {
    case "config": {
      const bookings = await deps.bookingsForPhone(call.phone);
      return { status: 200, body: {
        operator: cfg.name, demo: cfg.demoMode || cfg.policy.isDemo,
        now: when(deps.now.toISOString(), cfg.timezone, "es-AR"), today: utcToLocalDate(deps.now, cfg.timezone),
        callerName: call.name, callerPhoneLast4: call.phone.slice(-4),
        airports: cfg.airports.filter((a) => a.active).map((a) => ({ code: a.iata, name: a.name, meetingPointEs: a.meetingPointEs, meetingPointEn: a.meetingPointEn })),
        zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name })),
        vehicles: cfg.vehicleClasses.filter((v) => v.active).map((v) => ({ code: v.code, es: v.labelEs, en: v.labelEn,
          maxPassengers: v.maxPassengers, maxLargeBags: v.maxLargeBags, maxCarryOn: v.maxCarryOn })),
        rules: {
          leadTimeHours: Math.round(pc.lead_time_minutes / 60), maxAdvanceDays: pc.max_advance_days,
          freeCancellationHoursBefore: pc.cancellation.free_until_hours_before, refundPercentAfter: pc.cancellation.refund_percent_after,
          freeWaitAirportMinutes: pc.waiting.free_wait_minutes_airport, freeWaitCityMinutes: pc.waiting.free_wait_minutes_city,
          arrivalPickupBufferMinutes: pc.arrival_buffer_minutes, paymentModes: pc.allowed_payment_modes,
          flightTracked: true,
        },
        upcomingBookings: bookings.map((b) => ({ reference: b.reference, spoken: spellReference(b.reference), state: b.state,
          pickup: when(b.pickupAt, cfg.timezone, "es-AR"), route: b.direction === "from_airport" ? `${b.airport} → ${b.zone ?? ""}` : `${b.zone ?? ""} → ${b.airport}` })),
      } };
    }

    case "quote": {
      const direction = args.direction === "from_airport" || args.direction === "to_airport" ? (args.direction as Direction) : null;
      const zone = cfg.zones.find((z) => z.active && (z.code === str(args.zone) || z.name.toLowerCase() === str(args.zone).toLowerCase()));
      if (!direction) return { status: 200, body: { ok: false, problems: [L("falta saber si es desde o hacia el aeropuerto", "need to know if it's from or to the airport")] } };
      const r = computeQuote({
        direction, airport: str(args.airport, 3).toUpperCase(), zoneCode: zone?.code ?? str(args.zone, 40),
        place: { text: str(args.address), lat: null, lng: null }, date: str(args.date, 10), time: str(args.time, 5),
        flightDesignator: direction === "from_airport" ? str(args.flight, 10) || null : null,
        passengers: int(args.passengers), largeBags: int(args.largeBags), carryOn: int(args.carryOn ?? 0),
        vehicleClass: str(args.vehicleClass, 30) || null, locale: lang,
      }, cfg, { now: deps.now });
      if (r.kind === "invalid") {
        return { status: 200, body: { ok: false, problems: r.errors.map((e) => `${e.field}: ${(PROBLEM[e.code] ?? [e.code, e.code])[lang === "en" ? 1 : 0]}`),
          hint: L(`Recordá: mínimo ${Math.round(pc.lead_time_minutes / 60)} h de anticipación y hasta ${pc.max_advance_days} días.`,
                  `Remember: at least ${Math.round(pc.lead_time_minutes / 60)} h notice and up to ${pc.max_advance_days} days ahead.`) } };
      }
      if (r.kind === "manual") {
        return { status: 200, body: { ok: false, manual: true,
          say: L("Ese viaje lo cotiza una persona del equipo. Ofrecé que lo llamen por WhatsApp y usá note con callback.",
                 "A team member has to quote this trip. Offer a WhatsApp callback and use note with callback.") } };
      }
      const expiresAt = addMinutes(deps.now, pc.quote_expiry_minutes).toISOString();
      const { id } = await deps.store.insertQuote({
        operatorId: cfg.operatorId, sessionHash: await sessionHash(`voice:${callId}`), source: "voice", kind: "priced",
        journey: r.journey, vehicleClass: r.vehicleClass, fare: r.fare, policyId: cfg.policy.id, manualReasons: [], expiresAt,
      });
      const label = (code: string) => { const v = cfg.vehicleClasses.find((x) => x.code === code); return v ? (lang === "en" ? v.labelEn : v.labelEs) : code; };
      return { status: 200, body: {
        ok: true, quoteId: id, price: formatMoney(r.fare.totalMinor, r.fare.currency, lang), demoFare: r.fare.isDemo,
        vehicle: label(r.vehicleClass), pickup: when(r.journey.pickupAt, cfg.timezone, lang),
        pickupNote: r.journey.flight ? L(`El chofer espera ${r.journey.flight.bufferMinutes} minutos después del aterrizaje programado y sigue el vuelo.`,
          `The driver meets you ${r.journey.flight.bufferMinutes} minutes after the scheduled landing and tracks the flight.`) : null,
        otherVehicles: r.options.filter((o) => o.eligible && o.amountMinor !== null && o.code !== r.vehicleClass)
          .map((o) => ({ code: o.code, vehicle: label(o.code), price: formatMoney(o.amountMinor!, o.currency!, lang) })),
        validMinutes: pc.quote_expiry_minutes,
        paymentModes: pc.allowed_payment_modes.map((m) => ({ code: m, say: PAY_ES[m][lang === "en" ? 1 : 0] })),
      } };
    }

    case "book": {
      const quoteId = str(args.quoteId, 40);
      const name = str(args.name, 120);
      const paymentMode = pc.allowed_payment_modes.includes(args.paymentMode as PaymentMode) ? (args.paymentMode as PaymentMode) : null;
      if (!/^[0-9a-f-]{36}$/.test(quoteId) || name.length < 2 || !paymentMode) {
        return { status: 200, body: { ok: false, say: L("Faltan datos: necesito el precio confirmado, el nombre y la forma de pago.", "Missing details: I need the confirmed price, the name and the payment method.") } };
      }
      const idempotencyKey = `voice:${callId}:${quoteId}`;
      const contact = { name, phone: call.phone, email: null, locale: lang };
      const notes = str(args.notes, 300) || null;
      const statusToken = await deriveStatusToken(deps.statusTokenSecret, cfg.operatorId, idempotencyKey);
      try {
        const b = await deps.store.createBooking({
          operatorId: cfg.operatorId, quoteId, sessionHash: await sessionHash(`voice:${callId}`), idempotencyKey,
          requestHash: await sha256Hex(canonicalJson({ quoteId, contact, paymentMode, notes })),
          contact, paymentMode, notes, statusTokenHash: await sha256Hex(statusToken), actorId: null,
          flightExceptionReason: null, requestId: `voice-${callId}`.slice(0, 120),
        });
        const url = `${deps.publicAppUrl.replace(/\/$/, "")}/reserva/${b.reference}?t=${statusToken}`;
        const sent = b.replay ? true : await deps.sendWhatsApp(call, { type: "text", text: L(
          `✅ *Recibimos tu solicitud ${b.reference}* (por llamada)\n\nTodavía *no está confirmada*: estamos asignando un chofer y te avisamos por acá.\n\nVer estado: ${url}`,
          `✅ *We've received your request ${b.reference}* (by phone)\n\nIt is *not confirmed yet*: we're assigning a driver and will message you here.\n\nStatus: ${url}`) });
        return { status: 200, body: { ok: true, reference: b.reference, spoken: spellReference(b.reference), whatsappSent: sent,
          say: L("La solicitud quedó registrada. No está confirmada hasta que un chofer la acepte; le avisamos por WhatsApp.",
                 "The request is registered. It isn't confirmed until a driver accepts it; we'll let them know on WhatsApp.") } };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        const msg: Record<string, [string, string]> = {
          quote_expired: ["El precio venció; volvé a cotizar.", "The price expired; quote again."],
          pickup_too_soon: ["Ya no hay anticipación suficiente para ese horario.", "There's no longer enough notice for that time."],
          quote_not_found: ["No encuentro ese precio; volvé a cotizar.", "I can't find that price; quote again."],
          quote_already_used: ["Ese precio ya se usó para una reserva.", "That price was already used for a booking."],
        };
        return { status: 200, body: { ok: false, code: e.code, say: (msg[e.code] ?? ["No se pudo registrar; ofrecé que lo llame una persona.", "It couldn't be registered; offer a callback."])[lang === "en" ? 1 : 0] } };
      }
    }

    case "bookings": {
      const list = await deps.bookingsForPhone(call.phone);
      const ST: Record<string, [string, string]> = { needs_driver: ["buscando chofer", "finding a driver"], held: ["chofer reservado", "driver reserved"],
        confirmed: ["confirmada", "confirmed"], cancelled: ["cancelada", "cancelled"], requested: ["solicitada", "requested"], closed: ["finalizada", "completed"] };
      return { status: 200, body: { bookings: list.map((b) => ({ reference: b.reference, spoken: spellReference(b.reference),
        state: (ST[b.state] ?? [b.state, b.state])[lang === "en" ? 1 : 0], pickup: when(b.pickupAt, cfg.timezone, lang),
        route: b.direction === "from_airport" ? `${b.airport} → ${b.zone ?? ""}` : `${b.zone ?? ""} → ${b.airport}` })) } };
    }

    case "note": {
      const note = str(args.note, 500);
      const callback = args.callback === true;
      if (!note && !callback) return { status: 200, body: { ok: false } };
      await deps.note(callId, note, callback);
      return { status: 200, body: { ok: true } };
    }
  }
  return { status: 400, body: { error: { code: "invalid_action" } } };
}
