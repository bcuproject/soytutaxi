// supabase/functions/whatsapp/index.ts
import { createClient as createClient2 } from "npm:@supabase/supabase-js@2";

// supabase/functions/_shared/api/store.ts
var ApiError = class extends Error {
  constructor(status, code, message, fields, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.extra = extra;
  }
};

// supabase/functions/_shared/api/supabaseStore.ts
import { createClient } from "npm:@supabase/supabase-js@2";

// supabase/functions/_shared/api/configMapping.ts
function parseDateRange(r) {
  const m = /^[[(]([^,]*),([^)\]]*)[)\]]$/.exec(r.trim());
  if (!m) throw new Error(`bad daterange ${r}`);
  return { from: m[1] || "0001-01-01", to: m[2] ? m[2] : null };
}
function rowsToConfig(op, vc, ap, zn, fr, pol) {
  return {
    operatorId: op.id,
    slug: op.slug,
    name: op.name,
    timezone: op.timezone,
    demoMode: op.demo_mode,
    vehicleClasses: vc.map((v) => ({
      code: v.code,
      labelEs: v.label_es,
      labelEn: v.label_en,
      maxPassengers: v.max_passengers,
      maxLargeBags: v.max_large_bags,
      maxCarryOn: v.max_carry_on,
      maxBagUnits: v.max_bag_units,
      sortOrder: v.sort_order,
      active: v.active
    })),
    airports: ap.map((a) => ({
      id: a.id,
      iata: a.iata,
      name: a.name,
      meetingPointEs: a.meeting_point_es,
      meetingPointEn: a.meeting_point_en,
      lat: a.lat,
      lng: a.lng,
      active: a.active
    })),
    zones: zn.map((z) => ({ id: z.id, code: z.code, name: z.name, polygon: z.polygon, active: z.active })),
    fareRules: fr.map((f) => {
      const eff = parseDateRange(String(f.effective));
      return {
        id: f.id,
        direction: f.direction,
        airportId: f.airport_id,
        zoneId: f.zone_id,
        vehicleClass: f.vehicle_class,
        rank: f.rank,
        amountMinor: Number(f.amount_minor),
        taxesMinor: Number(f.taxes_minor),
        currency: f.currency,
        estDurationMin: f.est_duration_min,
        effectiveFrom: eff.from,
        effectiveTo: eff.to,
        version: f.version,
        active: f.active,
        isDemo: f.is_demo
      };
    }),
    policy: { id: pol.id, version: pol.version, label: pol.label, isDemo: pol.is_demo, config: pol.config }
  };
}

// supabase/functions/_shared/api/supabaseStore.ts
var CONFIG_TTL_MS = 6e4;
var SupabaseStore = class {
  db;
  cache = null;
  constructor(url, serviceRoleKey) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async loadConfig(slug) {
    if (this.cache && this.cache.slug === slug && Date.now() - this.cache.at < CONFIG_TTL_MS) return this.cache.cfg;
    const { data: op, error } = await this.db.from("operators").select("*").eq("slug", slug).maybeSingle();
    if (error) throw error;
    if (!op) return null;
    const [vc, ap, zn, fr, pol] = await Promise.all([
      this.db.from("vehicle_classes").select("*").eq("operator_id", op.id),
      this.db.from("airports").select("*").eq("operator_id", op.id),
      this.db.from("zones").select("*").eq("operator_id", op.id),
      this.db.from("fare_rules").select("*").eq("operator_id", op.id).eq("active", true),
      this.db.from("policies").select("*").eq("operator_id", op.id).lte("effective_from", (/* @__PURE__ */ new Date()).toISOString()).order("version", { ascending: false }).limit(1).maybeSingle()
    ]);
    for (const r of [vc, ap, zn, fr, pol]) if (r.error) throw r.error;
    if (!pol.data) return null;
    const cfg = rowsToConfig(op, vc.data, ap.data, zn.data, fr.data, pol.data);
    this.cache = { at: Date.now(), slug, cfg };
    return cfg;
  }
  async insertQuote(row) {
    const j = row.journey;
    const { data, error } = await this.db.from("quotes").insert({
      operator_id: row.operatorId,
      session_hash: row.sessionHash,
      source: row.source,
      kind: row.kind,
      direction: j.direction,
      airport_id: j.airportId,
      zone_id: j.zoneId,
      vehicle_class: row.vehicleClass,
      passengers: j.passengers,
      large_bags: j.largeBags,
      carry_on: j.carryOn,
      pickup_at: j.pickupAt,
      journey: j,
      fare: row.fare,
      amount_minor: row.fare?.totalMinor ?? null,
      currency: row.fare?.currency ?? null,
      fare_rule_id: row.fare?.fareRuleId ?? null,
      fare_rule_version: row.fare?.fareRuleVersion ?? null,
      policy_id: row.policyId,
      manual_reasons: row.manualReasons,
      expires_at: row.expiresAt
    }).select("id").single();
    if (error) throw error;
    return { id: data.id };
  }
  async createBooking(a) {
    const { data, error } = await this.db.rpc("create_booking_from_quote", {
      p_operator_id: a.operatorId,
      p_quote_id: a.quoteId,
      p_session_hash: a.sessionHash,
      p_idempotency_key: a.idempotencyKey,
      p_request_hash: a.requestHash,
      p_contact: a.contact,
      p_payment_mode: a.paymentMode,
      p_notes: a.notes,
      p_status_token_hash: a.statusTokenHash,
      p_actor_id: a.actorId,
      p_flight_exception_reason: a.flightExceptionReason,
      p_request_id: a.requestId
    });
    if (error) throw mapPgError(error);
    return { bookingId: data.booking_id, reference: data.reference, state: data.state, replay: data.replay };
  }
  async getBookingStatus(reference, tokenHash) {
    const { data, error } = await this.db.rpc("get_booking_status", { p_reference: reference, p_status_token_hash: tokenHash });
    if (error) throw mapPgError(error);
    return data ?? null;
  }
  async cancelTerms(reference, tokenHash) {
    const { data, error } = await this.db.rpc("passenger_cancel_preview", { p_reference: reference, p_token_hash: tokenHash });
    if (error) throw mapPgError(error);
    return data;
  }
  async cancelBooking(reference, tokenHash, reason) {
    const { data, error } = await this.db.rpc("passenger_cancel", { p_reference: reference, p_token_hash: tokenHash, p_reason: reason });
    if (error) throw mapPgError(error);
    return data;
  }
  async rateBooking(reference, tokenHash, score, comment) {
    const { data, error } = await this.db.rpc("passenger_rate", { p_reference: reference, p_token_hash: tokenHash, p_score: score, p_comment: comment });
    if (error) throw mapPgError(error);
    return data;
  }
  async resolveActor(bearer, operatorId) {
    const { data, error } = await this.db.auth.getUser(bearer);
    if (error || !data?.user) return null;
    const { data: rows } = await this.db.from("memberships").select("role").eq("operator_id", operatorId).eq("user_id", data.user.id).eq("active", true);
    const roles = (rows ?? []).map((r) => r.role);
    return roles.length ? { userId: data.user.id, roles } : null;
  }
};
function mapPgError(e) {
  if (e.code === "P0001" && e.message) {
    const status = Number(e.details) || 422;
    return new ApiError(status, e.message, e.hint ?? e.message);
  }
  if (e.code === "23P01") return new ApiError(409, "schedule_conflict", "Driver or vehicle already has an overlapping job.");
  return new Error(`db_error:${e.code ?? "unknown"}`);
}

// supabase/functions/_shared/whatsapp/ai.ts
var LOVABLE_GATEWAY = "https://ai.gateway.lovable.dev/v1";
function makeExtractor(cfg, fetchImpl = fetch) {
  const base = (cfg.baseUrl || LOVABLE_GATEWAY).replace(/\/$/, "");
  const lovable = base.includes("ai.gateway.lovable.dev");
  const model = cfg.model || (lovable ? "google/gemini-3-flash-preview" : "gpt-4o-mini");
  return {
    async extract(text, ctx) {
      const system = [
        "You extract airport-transfer booking details for SoyTuTaxi in Buenos Aires from one WhatsApp message.",
        `Today is ${ctx.weekday} ${ctx.today} (America/Argentina/Buenos_Aires). The bot is currently asking for: ${ctx.awaiting}.`,
        "Airports: EZE (Ezeiza) and AEP (Aeroparque Jorge Newbery). direction is from_airport when the passenger lands/arrives and needs a ride into the city, to_airport when they are going to catch a flight.",
        `City zones (use the code): ${ctx.zones.map((z) => `${z.code}=${z.name}`).join(", ")}.`,
        "Return ONLY a JSON object with keys: direction, airport, zone, address, date (YYYY-MM-DD), time (HH:mm 24h), flight, passengers, large_bags, carry_on, language (es|en), wants_staff.",
        "Use null for anything not stated. Never guess or invent values. Resolve relative dates (ma\xF1ana, tomorrow, el viernes) against today. For arrivals, time is the flight's scheduled landing time.",
        "address is the street and number or hotel/building name exactly as written (not the zone)."
      ].join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 4500);
      try {
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: lovable ? { "Lovable-API-Key": cfg.apiKey, "X-Lovable-AIG-SDK": "custom", "Content-Type": "application/json" } : { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: text.slice(0, 800) }]
          })
        });
        if (!r.ok) return null;
        const j = await r.json();
        const raw = String(j?.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?|```$/g, "").trim();
        const obj = JSON.parse(raw);
        return obj && typeof obj === "object" ? obj : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
function assistantPrompt(i) {
  return `You are the WhatsApp assistant of SoyTuTaxi, an airport transfer company in Buenos Aires (Ezeiza EZE and Aeroparque AEP).
Reply in the customer's language: Rioplatense Spanish with "vos" by default, English if they write in English.
WhatsApp style: short, warm, plain text, at most 3 short paragraphs, *bold* allowed, no markdown headers or tables.

Use ONLY the FACTS and the CUSTOMER data below. Never invent prices, times, drivers, flight data or policies.
If you don't know, say so and offer a person (action "staff").
The CUSTOMER data is this phone number's own memory: their bookings (with the driver's first name, car, plate and whether
he is on the way, once a driver accepted), their recent WhatsApp messages and their previous phone calls (notes and
the end of the transcript). Use it so they never have to repeat themselves: if they come back about something from a
previous chat or call, continue from there. Never reveal anything about other customers or the driver's phone number.
Prices for NEW trips come from the booking flow, not from you.

Choose ONE action:
- "answer": you answered the question in "reply".
- "book": they want a NEW booking or a price for a new trip (reply: a one-line friendly lead-in, the bot then asks the details).
- "bookings": they want to see the list of their bookings / status links.
- "cancel": they want to cancel a specific booking; set "reference" (from CUSTOMER bookings). If unclear which, use "answer" and ask.
- "staff": they want a person, want to CHANGE a booking (time, address, passengers\u2026), complain, or need something you can't do.
${i.awaiting !== "none" ? `The customer is in the middle of a booking; the bot is waiting for: ${i.awaiting}. Just answer their question ("answer"); the bot will repeat its question.
` : ""}
Return ONLY JSON: {"action": "...", "reply": "...", "reference": null, "language": "es"|"en"}

FACTS: ${JSON.stringify(i.facts)}
CUSTOMER: ${JSON.stringify(i.customer)}`;
}
function makeAssistant(cfg, fetchImpl = fetch) {
  const base = (cfg.baseUrl || LOVABLE_GATEWAY).replace(/\/$/, "");
  const lovable = base.includes("ai.gateway.lovable.dev");
  const model = cfg.model || (lovable ? "google/gemini-3-flash-preview" : "gpt-4o-mini");
  const ACTIONS = ["answer", "book", "bookings", "cancel", "staff"];
  return {
    async reply(input) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 9e3);
      try {
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: assistantPrompt(input) }, { role: "user", content: input.text.slice(0, 1e3) }]
          })
        });
        if (!r.ok) return null;
        const j = await r.json();
        const raw = String(j?.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?|```$/g, "").trim();
        const o = JSON.parse(raw);
        if (!o || !ACTIONS.includes(o.action)) return null;
        const reply = typeof o.reply === "string" ? o.reply.trim().slice(0, 1200) : "";
        if (o.action === "answer" && !reply) return null;
        const reference = typeof o.reference === "string" && /^[A-Z0-9-]{4,20}$/i.test(o.reference) ? o.reference.toUpperCase() : null;
        return { action: o.action, reply, reference, language: o.language === "en" || o.language === "es" ? o.language : null };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

// supabase/functions/_shared/whatsapp/meta.ts
var GRAPH_VERSION = "v22.0";
var enc = new TextEncoder();
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  return timingSafeEqual(sig, header.slice(7).toLowerCase());
}
function parseWebhook(body) {
  const out = { phoneNumberId: null, messages: [], statuses: [], calls: [] };
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      if (v?.metadata?.phone_number_id) out.phoneNumberId = String(v.metadata.phone_number_id);
      const names = /* @__PURE__ */ new Map();
      for (const c of v.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c?.profile?.name ?? ""));
      for (const m of v.messages ?? []) {
        const from = String(m?.from ?? "").replace(/\D/g, "");
        if (!m?.id || !from) continue;
        const base = { id: String(m.id), from, profileName: names.get(from) || void 0, timestamp: Number(m.timestamp) || 0, rawType: String(m.type) };
        if (m.type === "text") {
          out.messages.push({ ...base, type: "text", text: String(m.text?.body ?? "").slice(0, 2e3) });
        } else if (m.type === "interactive") {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          out.messages.push({ ...base, type: "reply", replyId: String(r?.id ?? ""), replyTitle: String(r?.title ?? "") });
        } else if (m.type === "button") {
          out.messages.push({ ...base, type: "reply", replyId: String(m.button?.payload ?? ""), replyTitle: String(m.button?.text ?? "") });
        } else if (m.type === "location" && Number.isFinite(Number(m.location?.latitude))) {
          out.messages.push({
            ...base,
            type: "location",
            location: { lat: Number(m.location.latitude), lng: Number(m.location.longitude), name: m.location.name, address: m.location.address }
          });
        } else {
          out.messages.push({ ...base, type: "other" });
        }
      }
      for (const c of v.calls ?? []) {
        if (!c?.id || c.event !== "connect" && c.event !== "terminate") continue;
        const from = String(c.from ?? "").replace(/\D/g, "");
        out.calls.push({
          id: String(c.id),
          from,
          profileName: names.get(from) || void 0,
          event: c.event,
          sdp: c.event === "connect" && c.session?.sdp_type === "offer" ? String(c.session.sdp ?? "") : void 0,
          status: c.status ? String(c.status) : void 0,
          duration: Number.isFinite(Number(c.duration)) ? Number(c.duration) : void 0,
          error: c.errors?.[0] ? `${c.errors[0].code}: ${c.errors[0].message ?? c.errors[0].title ?? ""}`.slice(0, 300) : void 0
        });
      }
      for (const s of v.statuses ?? []) {
        if (!s?.id || !["sent", "delivered", "read", "failed"].includes(s.status)) continue;
        out.statuses.push({
          id: String(s.id),
          status: s.status,
          recipient: String(s.recipient_id ?? ""),
          error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title ?? s.errors[0].message ?? ""}` : void 0
        });
      }
    }
  }
  return out;
}
var cut = (s, n) => s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
function toGraphPayload(to, m) {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (m.type) {
    case "text":
      return { ...base, type: "text", text: { body: cut(m.text, 4096), preview_url: !!m.previewUrl } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: cut(m.text, 1024) },
          ...m.footer ? { footer: { text: cut(m.footer, 60) } } : {},
          action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: cut(b.id, 256), title: cut(b.title, 20) } })) }
        }
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: cut(m.text, 1024) },
          ...m.footer ? { footer: { text: cut(m.footer, 60) } } : {},
          action: {
            button: cut(m.button, 20),
            sections: [{ title: cut(m.button, 24), rows: m.rows.slice(0, 10).map((r) => ({ id: cut(r.id, 200), title: cut(r.title, 24), ...r.description ? { description: cut(r.description, 72) } : {} })) }]
          }
        }
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: m.name,
          language: { code: m.language },
          components: [
            ...m.params.length ? [{ type: "body", parameters: m.params.map((t) => ({ type: "text", text: cut(t, 1e3) })) }] : [],
            ...(m.buttonPayloads ?? []).map((p, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: p }] }))
          ]
        }
      };
  }
}
function previewOf(m) {
  switch (m.type) {
    case "text":
      return m.text;
    case "buttons":
      return `${m.text}
[${m.buttons.map((b) => b.title).join("] [")}]`;
    case "list":
      return `${m.text}
\u25B8 ${m.button}: ${m.rows.map((r) => r.title).join(" \xB7 ")}`;
    case "template":
      return `(plantilla ${m.name}) ${m.params.join(" \xB7 ")}`;
  }
}
function graphSender(phoneNumberId, accessToken, fetchImpl = fetch) {
  return {
    async send(to, m) {
      try {
        const r = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(toGraphPayload(to, m)),
          signal: AbortSignal.timeout(1e4)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: `${r.status} ${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`.trim().slice(0, 300) };
        return { id: j?.messages?.[0]?.id };
      } catch (e) {
        return { error: `network: ${e.message}`.slice(0, 300) };
      }
    }
  };
}
function graphCalls(phoneNumberId, accessToken, fetchImpl = fetch) {
  return {
    async action(callId, action, sdp) {
      const body = { messaging_product: "whatsapp", call_id: callId, action };
      if (action === "pre_accept" || action === "accept") body.session = { sdp_type: "answer", sdp };
      try {
        const r = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/calls`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1e4)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.success === false) return { ok: false, error: `${r.status} ${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`.trim().slice(0, 300) };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `network: ${e.message}`.slice(0, 300) };
      }
    }
  };
}

// supabase/functions/_shared/domain/crypto.ts
var enc2 = new TextEncoder();
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64Url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(input) {
  return toHex(await crypto.subtle.digest("SHA-256", enc2.encode(input)));
}
async function hmacBase64Url(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, enc2.encode(message)));
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
async function deriveStatusToken(secret, operatorId, idempotencyKey) {
  return hmacBase64Url(secret, `status:${operatorId}:${idempotencyKey}`);
}
async function sessionHash(sessionId) {
  return sha256Hex(`session:${sessionId}`);
}

// supabase/functions/_shared/domain/fare.ts
function effectiveOn(rule, date) {
  return rule.effectiveFrom <= date && (rule.effectiveTo === null || date < rule.effectiveTo);
}
function matchFare(rules, q) {
  const candidates = rules.filter(
    (r) => r.active && r.direction === q.direction && r.airportId === q.airportId && r.vehicleClass === q.vehicleClass && (r.zoneId === null || r.zoneId === q.zoneId) && effectiveOn(r, q.pickupLocalDate)
  );
  if (candidates.length === 0) return { ok: false, reason: "no_fare_rule", candidates: [] };
  const specificity = (r) => r.zoneId === null ? 1 : 0;
  candidates.sort((a, b) => a.rank - b.rank || specificity(a) - specificity(b) || a.id.localeCompare(b.id));
  const [best, second] = candidates;
  if (second && second.rank === best.rank && specificity(second) === specificity(best)) {
    return { ok: false, reason: "ambiguous_fare_rules", candidates: candidates.map((c) => c.id) };
  }
  return {
    ok: true,
    rule: best,
    fare: {
      baseMinor: best.amountMinor,
      taxesMinor: best.taxesMinor,
      totalMinor: best.amountMinor + best.taxesMinor,
      currency: best.currency,
      fareRuleId: best.id,
      fareRuleVersion: best.version,
      estDurationMin: best.estDurationMin,
      isDemo: best.isDemo
    }
  };
}
function formatMoney(amountMinor, currency, locale) {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "es-AR", {
    style: "currency",
    currency,
    currencyDisplay: "code"
  }).format(amountMinor / 100);
}

// supabase/functions/_shared/domain/capacity.ts
var LARGE_BAG_UNITS = 2;
var CARRY_ON_UNITS = 1;
function eligibilityReasons(vc, load) {
  const reasons = [];
  if (!vc.active) reasons.push("class_inactive");
  if (load.passengers > vc.maxPassengers) reasons.push("too_many_passengers");
  if (load.largeBags > vc.maxLargeBags) reasons.push("too_many_large_bags");
  if (load.carryOn > vc.maxCarryOn) reasons.push("too_many_carry_on");
  if (vc.maxBagUnits !== null) {
    const units = load.largeBags * LARGE_BAG_UNITS + load.carryOn * CARRY_ON_UNITS;
    if (units > vc.maxBagUnits) reasons.push("combined_baggage_exceeded");
  }
  return reasons;
}
function orderedClasses(classes) {
  return [...classes].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

// supabase/functions/_shared/domain/geo.ts
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
function pointInZone(lng, lat, zone) {
  return zone.polygon.length > 0 && pointInRing(lng, lat, zone.polygon[0]);
}
function zonesContaining(lng, lat, zones) {
  return zones.filter((z) => z.active && pointInZone(lng, lat, z));
}
function isValidLatLng(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// supabase/functions/_shared/domain/time.ts
var OPERATOR_TZ = "America/Argentina/Buenos_Aires";
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isValidLocalDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
function isValidLocalTime(s) {
  return TIME_RE.test(s);
}
var fmtCache = /* @__PURE__ */ new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short"
    });
    fmtCache.set(tz, f);
  }
  return f;
}
var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function zonedParts(instant, tz = OPERATOR_TZ) {
  const out = {};
  for (const p of fmt(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WD[out.weekday]
  };
}
function offsetMs(instant, tz) {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1e3) * 1e3;
}
function localToUtc(date, time, tz = OPERATOR_TZ) {
  if (!isValidLocalDate(date) || !isValidLocalTime(time)) throw new Error(`invalid local date/time ${date} ${time}`);
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - offsetMs(new Date(wall), tz);
  guess = wall - offsetMs(new Date(guess), tz);
  return new Date(guess);
}
function utcToLocalDate(instant, tz = OPERATOR_TZ) {
  const p = zonedParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function utcToLocalTime(instant, tz = OPERATOR_TZ) {
  const p = zonedParts(instant, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
function addMinutes(d, minutes) {
  return new Date(d.getTime() + minutes * 6e4);
}
function addDaysLocal(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// supabase/functions/_shared/domain/quote.ts
var FLIGHT_RE = /^[A-Z0-9]{2}[A-Z]?[0-9]{1,4}[A-Z]?$/;
function normalizeFlight(raw) {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}
var int = (v) => typeof v === "number" && Number.isInteger(v);
function computeQuote(input, cfg, opts) {
  const errors = [];
  const pol = cfg.policy.config;
  const tz = cfg.timezone;
  if (input.direction !== "from_airport" && input.direction !== "to_airport") errors.push({ field: "direction", code: "invalid" });
  const airport = cfg.airports.find((a) => a.active && a.iata === String(input.airport ?? "").toUpperCase());
  if (!airport) errors.push({ field: "airport", code: "unsupported_airport" });
  const zone = cfg.zones.find((z) => z.active && z.code === input.zoneCode);
  if (!zone) errors.push({ field: "zoneCode", code: "outside_service_area" });
  const text = String(input.place?.text ?? "").trim();
  if (text.length < 3) errors.push({ field: "place.text", code: "required" });
  if (text.length > 300) errors.push({ field: "place.text", code: "too_long" });
  for (const [f, max] of [["passengers", 60], ["largeBags", 60], ["carryOn", 60]]) {
    const v = input[f];
    if (!int(v) || v < (f === "passengers" ? 1 : 0) || v > max) errors.push({ field: f, code: "invalid_count" });
  }
  if (!isValidLocalDate(input.date)) errors.push({ field: "date", code: "invalid_date" });
  if (!isValidLocalTime(input.time)) errors.push({ field: "time", code: "invalid_time" });
  let flight = null;
  if (input.flightDesignator) {
    flight = normalizeFlight(input.flightDesignator);
    if (!FLIGHT_RE.test(flight)) errors.push({ field: "flightDesignator", code: "invalid_flight" });
  } else if (input.direction === "from_airport" && !opts.allowMissingFlight) {
    errors.push({ field: "flightDesignator", code: "required" });
  }
  let verified = false;
  const lat = input.place?.lat ?? null;
  const lng = input.place?.lng ?? null;
  if (lat !== null || lng !== null) {
    if (!isValidLatLng(lat, lng)) {
      errors.push({ field: "place.coordinates", code: "invalid_coordinates" });
    } else if (zone) {
      if (pointInZone(lng, lat, zone)) {
        verified = true;
      } else {
        const actual = zonesContaining(lng, lat, cfg.zones);
        errors.push({ field: "place.coordinates", code: actual.length ? "location_zone_mismatch" : "outside_service_area" });
      }
    }
  }
  if (errors.length || !airport || !zone) return { kind: "invalid", errors };
  let pickupAt;
  let flightInfo = null;
  if (input.direction === "from_airport") {
    const arrival = localToUtc(input.date, input.time, tz);
    const buffer = pol.arrival_buffer_minutes[airport.iata] ?? 45;
    pickupAt = addMinutes(arrival, buffer);
    if (flight) {
      flightInfo = {
        designator: flight,
        localArrivalDate: input.date,
        scheduledArrivalAt: arrival.toISOString(),
        scheduledArrivalLocal: input.time,
        bufferMinutes: buffer
      };
    }
  } else {
    pickupAt = localToUtc(input.date, input.time, tz);
  }
  const earliest = addMinutes(opts.now, pol.lead_time_minutes);
  if (pickupAt < earliest) errors.push({ field: "time", code: pickupAt < opts.now ? "in_past" : "inside_lead_time" });
  const latestDate = addDaysLocal(utcToLocalDate(opts.now, tz), pol.max_advance_days);
  if (input.date > latestDate) errors.push({ field: "date", code: "too_far_ahead" });
  if (errors.length) return { kind: "invalid", errors };
  const cityPlace = {
    label: text,
    originalText: String(input.place.text),
    lat,
    lng,
    verified,
    zoneCode: zone.code,
    kind: "address"
  };
  const airportPlace = {
    label: `${airport.name} (${airport.iata})`,
    originalText: airport.iata,
    lat: airport.lat,
    lng: airport.lng,
    verified: true,
    zoneCode: null,
    kind: "airport"
  };
  const journey = {
    direction: input.direction,
    airportIata: airport.iata,
    airportId: airport.id,
    zoneId: zone.id,
    zoneCode: zone.code,
    pickup: input.direction === "from_airport" ? airportPlace : cityPlace,
    dropoff: input.direction === "from_airport" ? cityPlace : airportPlace,
    pickupAt: pickupAt.toISOString(),
    pickupLocalDate: utcToLocalDate(pickupAt, tz),
    pickupLocalTime: utcToLocalTime(pickupAt, tz),
    flight: flightInfo,
    passengers: input.passengers,
    largeBags: input.largeBags,
    carryOn: input.carryOn,
    locale: input.locale === "en" ? "en" : "es-AR"
  };
  const load = { passengers: input.passengers, largeBags: input.largeBags, carryOn: input.carryOn };
  const options = orderedClasses(cfg.vehicleClasses).map((vc) => {
    const reasons = eligibilityReasons(vc, load);
    const match2 = matchFare(cfg.fareRules, {
      direction: input.direction,
      airportId: airport.id,
      zoneId: zone.id,
      vehicleClass: vc.code,
      pickupLocalDate: journey.pickupLocalDate
    });
    return {
      code: vc.code,
      eligible: reasons.length === 0,
      reasons,
      amountMinor: match2.ok ? match2.fare.totalMinor : null,
      currency: match2.ok ? match2.fare.currency : null
    };
  });
  let chosen = null;
  if (input.vehicleClass) {
    const opt = options.find((o) => o.code === input.vehicleClass);
    if (!opt) return { kind: "invalid", errors: [{ field: "vehicleClass", code: "unknown_vehicle_class" }], options };
    if (!opt.eligible) return { kind: "invalid", errors: [{ field: "vehicleClass", code: "vehicle_not_eligible" }], options };
    chosen = opt.code;
  } else {
    chosen = options.find((o) => o.eligible && o.amountMinor !== null)?.code ?? options.find((o) => o.eligible)?.code ?? null;
  }
  if (!chosen) return { kind: "manual", journey, vehicleClass: null, reasons: ["no_vehicle_fits"], options };
  const match = matchFare(cfg.fareRules, {
    direction: input.direction,
    airportId: airport.id,
    zoneId: zone.id,
    vehicleClass: chosen,
    pickupLocalDate: journey.pickupLocalDate
  });
  if (!match.ok) return { kind: "manual", journey, vehicleClass: chosen, reasons: [match.reason], options };
  return { kind: "priced", journey, vehicleClass: chosen, fare: match.fare, options };
}

// supabase/functions/_shared/whatsapp/facts.ts
function localWhen(iso2, tz, lc) {
  const l = lc === "en" ? "en-GB" : "es-AR";
  const d = new Date(iso2);
  return `${new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d)}, ${new Intl.DateTimeFormat(l, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
}
var STATE = {
  requested: ["recibida", "received"],
  needs_driver: ["buscando chofer", "looking for a driver"],
  held: ["chofer reservado, falta el pago", "driver reserved, waiting for payment"],
  confirmed: ["confirmada", "confirmed"],
  closed: ["viaje realizado", "trip completed"],
  cancelled: ["cancelada", "cancelled"]
};
var STAGE = {
  scheduled: ["todav\xEDa no sali\xF3", "not on the way yet"],
  en_route: ["en camino", "on the way"],
  at_pickup: ["ya lleg\xF3 al punto de encuentro", "has arrived at the pickup point"],
  onboard: ["viaje en curso", "trip in progress"],
  complete: ["viaje terminado", "trip finished"],
  no_show: ["marcado como pasajero no presentado", "marked as no-show"]
};
var PAY = {
  prepaid: ["prepago online", "prepaid online"],
  pay_on_pickup_cash: ["efectivo al chofer", "cash to the driver"],
  pay_on_pickup_card: ["tarjeta al chofer", "card to the driver"],
  account: ["a cuenta de su hotel/agencia", "billed to their hotel/agency"]
};
function operatorFacts(cfg, now) {
  const pc = cfg.policy.config;
  return {
    operator: cfg.name,
    demo: cfg.demoMode || cfg.policy.isDemo,
    now: localWhen(now.toISOString(), cfg.timezone, "es-AR"),
    today: utcToLocalDate(now, cfg.timezone),
    airports: cfg.airports.filter((a) => a.active).map((a) => ({ code: a.iata, name: a.name, meetingPointEs: a.meetingPointEs, meetingPointEn: a.meetingPointEn })),
    zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name })),
    vehicles: cfg.vehicleClasses.filter((v) => v.active).map((v) => ({
      code: v.code,
      es: v.labelEs,
      en: v.labelEn,
      maxPassengers: v.maxPassengers,
      maxLargeBags: v.maxLargeBags,
      maxCarryOn: v.maxCarryOn
    })),
    rules: {
      leadTimeHours: Math.round(pc.lead_time_minutes / 60),
      maxAdvanceDays: pc.max_advance_days,
      freeCancellationHoursBefore: pc.cancellation.free_until_hours_before,
      refundPercentAfter: pc.cancellation.refund_percent_after,
      freeWaitAirportMinutes: pc.waiting.free_wait_minutes_airport,
      freeWaitCityMinutes: pc.waiting.free_wait_minutes_city,
      arrivalPickupBufferMinutes: pc.arrival_buffer_minutes,
      paymentModes: pc.allowed_payment_modes,
      flightTracked: true
    }
  };
}
function customerFacts(c, cfg, lc) {
  if (!c) return null;
  const en2 = lc === "en" ? 1 : 0;
  const w = (iso2) => iso2 ? localWhen(iso2, cfg.timezone, lc) : null;
  return {
    name: c.name,
    bookings: c.bookings.map((b) => ({
      reference: b.reference,
      status: (STATE[b.state] ?? [b.state, b.state])[en2],
      route: b.direction === "from_airport" ? `${b.airport} \u2192 ${b.dropoffPlace ?? b.zone ?? ""}` : `${b.pickupPlace ?? b.zone ?? ""} \u2192 ${b.airport}`,
      pickup: w(b.pickupAt),
      proposedNewPickup: w(b.proposedPickupAt),
      flight: b.flight ? { number: b.flight, status: b.flightStatus, estimatedArrival: w(b.flightEstimatedArrivalAt) } : null,
      party: `${b.passengers} pax, ${b.largeBags} large bags, ${b.carryOn} carry-on`,
      vehicle: b.vehicleClass,
      price: b.amountMinor != null && b.currency ? formatMoney(b.amountMinor, b.currency, lc) : null,
      payment: (PAY[b.paymentMode] ?? [b.paymentMode, b.paymentMode])[en2] + (b.paid ? en2 ? " (paid)" : " (pagado)" : ""),
      driver: b.driver ? { name: b.driver.firstName, car: b.driver.vehicle, plate: b.driver.plate, status: (STAGE[b.driver.stage] ?? [b.driver.stage, b.driver.stage])[en2] } : null,
      cancelledReason: b.cancelledReason,
      rating: b.rating
    })),
    recentWhatsApp: c.messages.map((m) => `${w(m.at)} \xB7 ${m.from}: ${m.text}`),
    previousCalls: c.calls.map((k) => ({
      when: w(k.at),
      answeredBy: k.handledBy,
      transferredToStaff: k.transferred,
      minutes: k.durationS ? Math.round(k.durationS / 60) : null,
      note: k.note,
      callbackPending: k.callbackPending,
      booking: k.booking,
      transcriptEnd: k.transcript
    }))
  };
}

// supabase/functions/_shared/whatsapp/voice.ts
var voiceToken = (secret, providerCallId) => hmacBase64Url(secret, `voice:${providerCallId}`);
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
var enc3 = new TextEncoder();
var b64url = (data) => {
  const bytes = typeof data === "string" ? enc3.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function connectorJwt(apiKey, apiSecret, now = /* @__PURE__ */ new Date()) {
  const iat = Math.floor(now.getTime() / 1e3);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: apiKey,
    sub: "soytutaxi-webhook",
    nbf: iat - 5,
    iat,
    exp: iat + 600,
    video: { roomCreate: true, roomAdmin: true },
    sip: { call: true, admin: true }
  }));
  const key = await crypto.subtle.importKey("raw", enc3.encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc3.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
var VOICE_AGENT_NAME = "bcu-taxi";
var VOICE_ASSISTANT = "soytutaxi";
function liveKitVoiceBot(cfg, fetchImpl = fetch) {
  const base = cfg.url.replace(/^wss?:/, "https:").replace(/\/$/, "");
  async function call(method, body) {
    const r = await fetchImpl(`${base}/twirp/livekit.Connector/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await connectorJwt(cfg.apiKey, cfg.apiSecret)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9e3)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`livekit ${method} ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  }
  return {
    async accept(a) {
      await call("AcceptWhatsAppCall", {
        whatsapp_phone_number_id: cfg.phoneNumberId,
        whatsapp_api_key: cfg.waToken,
        whatsapp_cloud_api_version: "23.0",
        whatsapp_call_id: a.callId,
        sdp: { type: "offer", sdp: a.sdp },
        room_name: a.room,
        agents: [{ agent_name: VOICE_AGENT_NAME }],
        participant_identity: `caller-${a.callerPhone.replace(/\D/g, "")}`,
        participant_attributes: a.attributes
      });
    },
    async disconnect(callId) {
      await call("DisconnectWhatsAppCall", { whatsapp_call_id: callId, whatsapp_api_key: cfg.waToken });
    }
  };
}
var PAY_ES = {
  prepaid: ["pago online con link", "online payment link"],
  pay_on_pickup_cash: ["efectivo al chofer", "cash to the driver"],
  pay_on_pickup_card: ["tarjeta al chofer", "card to the driver"],
  account: ["a cuenta (facturaci\xF3n mensual)", "on account (monthly invoice)"]
};
var spellReference = (ref) => {
  const [a, b] = ref.split("-");
  return `${a.split("").join(" ")}, ${(b ?? "").split("").join(" ")}`;
};
function when(iso2, tz, lc) {
  const l = lc === "en" ? "en-GB" : "es-AR";
  const d = new Date(iso2);
  return `${new Intl.DateTimeFormat(l, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d)}, ${new Intl.DateTimeFormat(l, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
}
var str = (v, max = 200) => typeof v === "string" ? v.trim().slice(0, max) : "";
var int2 = (v) => Number.isInteger(v) ? v : typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
var PROBLEM = {
  outside_service_area: ["esa zona no est\xE1 en nuestro servicio", "that area isn't in our service zones"],
  unsupported_airport: ["solo operamos Ezeiza y Aeroparque", "we only serve Ezeiza and Aeroparque"],
  invalid_flight: ["el n\xFAmero de vuelo no parece v\xE1lido", "the flight number doesn't look valid"],
  required: ["falta un dato", "a detail is missing"],
  invalid_date: ["la fecha no es v\xE1lida", "the date isn't valid"],
  invalid_time: ["la hora no es v\xE1lida", "the time isn't valid"],
  invalid_count: ["la cantidad de pasajeros o valijas no es v\xE1lida", "the number of passengers or bags isn't valid"],
  in_past: ["ese horario ya pas\xF3", "that time has already passed"],
  inside_lead_time: ["necesitamos m\xE1s anticipaci\xF3n", "we need more notice"],
  too_far_ahead: ["es demasiado adelante", "that's too far ahead"],
  vehicle_not_eligible: ["ese veh\xEDculo no alcanza para el grupo", "that vehicle is too small for the group"]
};
async function voiceTool(deps2, input) {
  const callId = str(input.callId, 300);
  const token = str(input.token, 200);
  if (!callId || !token || !safeEqual(token, await voiceToken(deps2.secret, callId))) return { status: 401, body: { error: { code: "unauthenticated" } } };
  const call = await deps2.call(callId);
  if (!call || call.handledBy !== "bot") return { status: 404, body: { error: { code: "call_not_found" } } };
  if (call.endedAt && deps2.now.getTime() - new Date(call.endedAt).getTime() > 10 * 6e4) return { status: 410, body: { error: { code: "call_over" } } };
  const cfg = deps2.cfg;
  const lang = input.language === "en" ? "en" : "es-AR";
  const L = (es2, en2) => lang === "en" ? en2 : es2;
  const args = input.args && typeof input.args === "object" ? input.args : {};
  const pc = cfg.policy.config;
  switch (String(input.action)) {
    case "config": {
      const bookings = await deps2.bookingsForPhone(call.phone);
      const memory = deps2.customerContext ? await deps2.customerContext(call.phone).catch(() => null) : null;
      return { status: 200, body: {
        ...operatorFacts(cfg, deps2.now),
        callerName: call.name,
        callerPhoneLast4: call.phone.slice(-4),
        upcomingBookings: bookings.map((b) => ({
          reference: b.reference,
          spoken: spellReference(b.reference),
          state: b.state,
          pickup: when(b.pickupAt, cfg.timezone, "es-AR"),
          route: b.direction === "from_airport" ? `${b.airport} \u2192 ${b.zone ?? ""}` : `${b.zone ?? ""} \u2192 ${b.airport}`
        })),
        customer: customerFacts(memory, cfg, "es-AR")
      } };
    }
    case "transcript": {
      await deps2.saveTranscript?.(callId, str(args.transcript, 8e3));
      return { status: 200, body: { ok: true } };
    }
    case "quote": {
      const direction = args.direction === "from_airport" || args.direction === "to_airport" ? args.direction : null;
      const zone = cfg.zones.find((z) => z.active && (z.code === str(args.zone) || z.name.toLowerCase() === str(args.zone).toLowerCase()));
      if (!direction) return { status: 200, body: { ok: false, problems: [L("falta saber si es desde o hacia el aeropuerto", "need to know if it's from or to the airport")] } };
      const r = computeQuote({
        direction,
        airport: str(args.airport, 3).toUpperCase(),
        zoneCode: zone?.code ?? str(args.zone, 40),
        place: { text: str(args.address), lat: null, lng: null },
        date: str(args.date, 10),
        time: str(args.time, 5),
        flightDesignator: direction === "from_airport" ? str(args.flight, 10) || null : null,
        passengers: int2(args.passengers),
        largeBags: int2(args.largeBags),
        carryOn: int2(args.carryOn ?? 0),
        vehicleClass: str(args.vehicleClass, 30) || null,
        locale: lang
      }, cfg, { now: deps2.now });
      if (r.kind === "invalid") {
        return { status: 200, body: {
          ok: false,
          problems: r.errors.map((e) => `${e.field}: ${(PROBLEM[e.code] ?? [e.code, e.code])[lang === "en" ? 1 : 0]}`),
          hint: L(
            `Record\xE1: m\xEDnimo ${Math.round(pc.lead_time_minutes / 60)} h de anticipaci\xF3n y hasta ${pc.max_advance_days} d\xEDas.`,
            `Remember: at least ${Math.round(pc.lead_time_minutes / 60)} h notice and up to ${pc.max_advance_days} days ahead.`
          )
        } };
      }
      if (r.kind === "manual") {
        return { status: 200, body: {
          ok: false,
          manual: true,
          say: L(
            "Ese viaje lo cotiza una persona del equipo. Ofrec\xE9 que lo llamen por WhatsApp y us\xE1 note con callback.",
            "A team member has to quote this trip. Offer a WhatsApp callback and use note with callback."
          )
        } };
      }
      const expiresAt = addMinutes(deps2.now, pc.quote_expiry_minutes).toISOString();
      const { id } = await deps2.store.insertQuote({
        operatorId: cfg.operatorId,
        sessionHash: await sessionHash(`voice:${callId}`),
        source: "voice",
        kind: "priced",
        journey: r.journey,
        vehicleClass: r.vehicleClass,
        fare: r.fare,
        policyId: cfg.policy.id,
        manualReasons: [],
        expiresAt
      });
      const label = (code) => {
        const v = cfg.vehicleClasses.find((x) => x.code === code);
        return v ? lang === "en" ? v.labelEn : v.labelEs : code;
      };
      return { status: 200, body: {
        ok: true,
        quoteId: id,
        price: formatMoney(r.fare.totalMinor, r.fare.currency, lang),
        demoFare: r.fare.isDemo,
        vehicle: label(r.vehicleClass),
        pickup: when(r.journey.pickupAt, cfg.timezone, lang),
        pickupNote: r.journey.flight ? L(
          `El chofer espera ${r.journey.flight.bufferMinutes} minutos despu\xE9s del aterrizaje programado y sigue el vuelo.`,
          `The driver meets you ${r.journey.flight.bufferMinutes} minutes after the scheduled landing and tracks the flight.`
        ) : null,
        otherVehicles: r.options.filter((o) => o.eligible && o.amountMinor !== null && o.code !== r.vehicleClass).map((o) => ({ code: o.code, vehicle: label(o.code), price: formatMoney(o.amountMinor, o.currency, lang) })),
        validMinutes: pc.quote_expiry_minutes,
        paymentModes: pc.allowed_payment_modes.map((m) => ({ code: m, say: PAY_ES[m][lang === "en" ? 1 : 0] }))
      } };
    }
    case "book": {
      const quoteId = str(args.quoteId, 40);
      const name = str(args.name, 120);
      const paymentMode = pc.allowed_payment_modes.includes(args.paymentMode) ? args.paymentMode : null;
      if (!/^[0-9a-f-]{36}$/.test(quoteId) || name.length < 2 || !paymentMode) {
        return { status: 200, body: { ok: false, say: L("Faltan datos: necesito el precio confirmado, el nombre y la forma de pago.", "Missing details: I need the confirmed price, the name and the payment method.") } };
      }
      const idempotencyKey = `voice:${callId}:${quoteId}`;
      const contact = { name, phone: call.phone, email: null, locale: lang };
      const notes = str(args.notes, 300) || null;
      const statusToken = await deriveStatusToken(deps2.statusTokenSecret, cfg.operatorId, idempotencyKey);
      try {
        const b = await deps2.store.createBooking({
          operatorId: cfg.operatorId,
          quoteId,
          sessionHash: await sessionHash(`voice:${callId}`),
          idempotencyKey,
          requestHash: await sha256Hex(canonicalJson({ quoteId, contact, paymentMode, notes })),
          contact,
          paymentMode,
          notes,
          statusTokenHash: await sha256Hex(statusToken),
          actorId: null,
          flightExceptionReason: null,
          requestId: `voice-${callId}`.slice(0, 120)
        });
        const url = `${deps2.publicAppUrl.replace(/\/$/, "")}/reserva/${b.reference}?t=${statusToken}`;
        const sent = b.replay ? true : await deps2.sendWhatsApp(call, { type: "text", text: L(
          `\u2705 *Recibimos tu solicitud ${b.reference}* (por llamada)

Todav\xEDa *no est\xE1 confirmada*: estamos asignando un chofer y te avisamos por ac\xE1.

Ver estado: ${url}`,
          `\u2705 *We've received your request ${b.reference}* (by phone)

It is *not confirmed yet*: we're assigning a driver and will message you here.

Status: ${url}`
        ) });
        return { status: 200, body: {
          ok: true,
          reference: b.reference,
          spoken: spellReference(b.reference),
          whatsappSent: sent,
          say: L(
            "La solicitud qued\xF3 registrada. No est\xE1 confirmada hasta que un chofer la acepte; le avisamos por WhatsApp.",
            "The request is registered. It isn't confirmed until a driver accepts it; we'll let them know on WhatsApp."
          )
        } };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        const msg = {
          quote_expired: ["El precio venci\xF3; volv\xE9 a cotizar.", "The price expired; quote again."],
          pickup_too_soon: ["Ya no hay anticipaci\xF3n suficiente para ese horario.", "There's no longer enough notice for that time."],
          quote_not_found: ["No encuentro ese precio; volv\xE9 a cotizar.", "I can't find that price; quote again."],
          quote_already_used: ["Ese precio ya se us\xF3 para una reserva.", "That price was already used for a booking."]
        };
        return { status: 200, body: { ok: false, code: e.code, say: (msg[e.code] ?? ["No se pudo registrar; ofrec\xE9 que lo llame una persona.", "It couldn't be registered; offer a callback."])[lang === "en" ? 1 : 0] } };
      }
    }
    case "bookings": {
      const list = await deps2.bookingsForPhone(call.phone);
      const ST = {
        needs_driver: ["buscando chofer", "finding a driver"],
        held: ["chofer reservado", "driver reserved"],
        confirmed: ["confirmada", "confirmed"],
        cancelled: ["cancelada", "cancelled"],
        requested: ["solicitada", "requested"],
        closed: ["finalizada", "completed"]
      };
      return { status: 200, body: { bookings: list.map((b) => ({
        reference: b.reference,
        spoken: spellReference(b.reference),
        state: (ST[b.state] ?? [b.state, b.state])[lang === "en" ? 1 : 0],
        pickup: when(b.pickupAt, cfg.timezone, lang),
        route: b.direction === "from_airport" ? `${b.airport} \u2192 ${b.zone ?? ""}` : `${b.zone ?? ""} \u2192 ${b.airport}`
      })) } };
    }
    case "cancel": {
      if (!deps2.cancel) return { status: 200, body: { ok: false, say: L("No puedo cancelar por tel\xE9fono; ofrec\xE9 que lo llame una persona.", "I can't cancel by phone; offer a callback.") } };
      const reference = str(args.reference, 20).toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9-]{4,20}$/.test(reference)) return { status: 200, body: { ok: false, say: L("Ped\xED el c\xF3digo de la reserva.", "Ask for the booking reference.") } };
      const confirm = args.confirm === true;
      const why = {
        driver_on_the_way: ["el chofer ya est\xE1 en camino", "the driver is already on the way"],
        trip_started: ["el viaje ya empez\xF3", "the trip has started"],
        already_cancelled: ["ya estaba cancelada", "it was already cancelled"],
        already_closed: ["el viaje ya termin\xF3", "the trip has finished"],
        booking_not_found: ["no hay una reserva con ese c\xF3digo para este n\xFAmero", "there's no booking with that reference for this number"]
      };
      const money = (n, c) => c ? formatMoney(n, c, lang) : String(n);
      try {
        const t = await deps2.cancel(call.phone, reference, confirm);
        if (t.cancelled) {
          return { status: 200, body: {
            ok: true,
            cancelled: true,
            refund: t.refundMinor > 0 ? money(t.refundMinor, t.currency) : null,
            say: t.refundMinor > 0 ? L(`Listo, qued\xF3 cancelada. El reembolso de ${money(t.refundMinor, t.currency)} se procesa solo.`, `Done, it's cancelled. The ${money(t.refundMinor, t.currency)} refund is processed automatically.`) : L("Listo, qued\xF3 cancelada.", "Done, it's cancelled.")
          } };
        }
        if (!t.allowed) {
          const w = (why[t.reason ?? ""] ?? [String(t.reason), String(t.reason)])[lang === "en" ? 1 : 0];
          return { status: 200, body: { ok: false, say: L(`No se puede cancelar por ac\xE1: ${w}. Ofrec\xE9 que lo llame una persona.`, `It can't be cancelled here: ${w}. Offer a callback.`) } };
        }
        const refund = t.paidMinor <= 0 ? L("sin cargo", "no charge") : t.refundMinor > 0 ? L(`se devuelve ${money(t.refundMinor, t.currency)} (${t.refundPercent}%)`, `${money(t.refundMinor, t.currency)} is refunded (${t.refundPercent}%)`) : L(`no hay reembolso porque faltan menos de ${t.freeUntilHoursBefore} horas`, `no refund, as it's less than ${t.freeUntilHoursBefore} hours before`);
        return { status: 200, body: {
          ok: true,
          needsConfirm: true,
          pickup: when(t.pickupAt, cfg.timezone, lang),
          refund,
          say: L(
            `Confirm\xE1 con el cliente: cancelar ${spellReference(reference)} del ${when(t.pickupAt, cfg.timezone, lang)}; ${refund}. Si dice que s\xED, llam\xE1 de nuevo con confirm=true.`,
            `Confirm with the caller: cancel ${spellReference(reference)} on ${when(t.pickupAt, cfg.timezone, lang)}; ${refund}. If yes, call again with confirm=true.`
          )
        } };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        const w = (why[e.code] ?? [e.code, e.code])[lang === "en" ? 1 : 0];
        return { status: 200, body: { ok: false, say: L(`No se pudo cancelar: ${w}.`, `It couldn't be cancelled: ${w}.`) } };
      }
    }
    case "transfer": {
      if (!deps2.transfer) return { status: 200, body: { ok: false, say: L("No hay transferencia disponible; ofrec\xE9 que lo llamen por WhatsApp.", "Transfer isn't available; offer a WhatsApp callback.") } };
      const r = await deps2.transfer(callId, str(args.reason, 300));
      return { status: 200, body: r.ok ? { ok: true, waitSeconds: 45, say: L("Dec\xED que lo pas\xE1s con una persona del equipo y que aguarde un momento en l\xEDnea.", "Say you're putting them through to a team member and to hold on a moment.") } : { ok: false, say: L("No se pudo transferir; ofrec\xE9 que lo llamen por WhatsApp.", "The transfer failed; offer a WhatsApp callback.") } };
    }
    case "transfer_failed": {
      await deps2.transferFailed?.(callId);
      return { status: 200, body: { ok: true } };
    }
    case "note": {
      const note = str(args.note, 500);
      const callback = args.callback === true;
      if (!note && !callback) return { status: 200, body: { ok: false } };
      await deps2.note(callId, note, callback);
      return { status: 200, body: { ok: true } };
    }
  }
  return { status: 400, body: { error: { code: "invalid_action" } } };
}

// supabase/functions/_shared/domain/livekit.ts
var enc4 = new TextEncoder();
function b64url2(data) {
  const bytes = typeof data === "string" ? enc4.encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function mintLiveKitToken(g) {
  const iat = Math.floor((g.now ?? /* @__PURE__ */ new Date()).getTime() / 1e3);
  const payload = {
    iss: g.apiKey,
    sub: g.identity,
    name: g.name,
    nbf: iat - 10,
    iat,
    exp: iat + (g.ttlSeconds ?? 4 * 3600),
    metadata: g.metadata ? JSON.stringify(g.metadata) : void 0,
    video: {
      room: g.room,
      roomJoin: true,
      canPublish: g.canPublish,
      canPublishSources: g.canPublish ? ["microphone"] : [],
      canSubscribe: true,
      canPublishData: false
    }
  };
  const head = b64url2(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url2(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc4.encode(g.apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc4.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url2(sig)}`;
}

// supabase/functions/_shared/whatsapp/setup.ts
function graph(token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const r = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...body ? { "content-type": "application/json" } : {} },
      body: body ? JSON.stringify(body) : void 0
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok && !data?.error, status: r.status, data };
  };
}
var metaError = (d) => ({
  code: d?.error?.code ?? null,
  subcode: d?.error?.error_subcode ?? null,
  message: String(d?.error?.error_user_msg || d?.error?.message || "Meta error").slice(0, 400)
});
var PHONE_FIELDS = "id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type,messaging_limit_tier,webhook_configuration";
var TEMPLATES = [
  {
    kind: "notify.passenger.confirmed",
    name: "stt_trip_confirmed",
    category: "UTILITY",
    body: "\u2705 Tu viaje {{1}} del {{2}} est\xE1 confirmado. Tu chofer es {{3}} ({{4}}). Detalles y estado: {{5}} \xA1Buen viaje!",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30", "Carlos", "Toyota Corolla AB123CD", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"]
  },
  {
    kind: "notify.passenger.cancelled",
    name: "stt_trip_cancelled",
    category: "UTILITY",
    body: "Tu reserva {{1}} fue cancelada. Si es un error o necesit\xE1s ayuda, respond\xE9 a este mensaje.",
    example: ["STT-AB12CD"]
  },
  {
    kind: "notify.passenger.payment_due",
    name: "stt_payment_due",
    category: "UTILITY",
    body: "Reservamos un chofer para tu viaje {{1}} del {{2}}. Para confirmarlo, pag\xE1 {{3}} ac\xE1: {{4}} \xA1Gracias!",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30", "$ 50.000", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"]
  },
  {
    kind: "notify.passenger.pickup_changed",
    name: "stt_pickup_changed",
    category: "UTILITY",
    body: "Tu vuelo cambi\xF3 de horario: actualizamos la b\xFAsqueda de tu viaje {{1}} a las {{2}}. Detalles: {{3}} \xA1Gracias!",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 11:15", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"]
  },
  {
    kind: "notify.passenger.reminder",
    name: "stt_trip_reminder",
    category: "UTILITY",
    body: "\u23F0 Recordatorio: tu viaje {{1}} es el {{2}}. Si necesit\xE1s cambiar o cancelar, respond\xE9 ac\xE1 o entr\xE1 a {{3}} \xA1Te esperamos!",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30", "https://bcuproject.github.io/soytutaxi/reserva/STT-AB12CD"]
  },
  {
    kind: "notify.passenger.rating",
    name: "stt_trip_rating",
    category: "UTILITY",
    body: "\xA1Gracias por viajar con SoyTuTaxi! \xBFC\xF3mo estuvo tu viaje {{1}}? Pod\xE9s calificarlo desde el link de tu reserva.",
    example: ["STT-AB12CD"]
  },
  {
    kind: "notify.passenger.refund",
    name: "stt_refund",
    category: "UTILITY",
    body: "Procesamos el reembolso de tu reserva {{1}}. Puede tardar unos d\xEDas h\xE1biles en verse en tu medio de pago.",
    example: ["STT-AB12CD"]
  },
  {
    kind: "notify.driver.offer",
    name: "stt_driver_offer_v2",
    category: "UTILITY",
    body: "\u{1F695} Viaje disponible {{1}}: {{2}}. Ganancia {{3}}. Aceptalo con el bot\xF3n o desde la app de choferes.",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30", "$ 35.000"],
    buttons: ["Aceptar", "Rechazar"]
  },
  {
    kind: "notify.driver.assigned",
    name: "stt_driver_assigned",
    category: "UTILITY",
    body: "Ten\xE9s asignado el viaje {{1}} del {{2}}. Los detalles est\xE1n en la app de choferes.",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30"]
  },
  {
    kind: "notify.driver.pickup_changed",
    name: "stt_driver_pickup_changed",
    category: "UTILITY",
    body: "Cambi\xF3 el horario del viaje {{1}}: nueva b\xFAsqueda {{2}}. Revisalo en la app de choferes.",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 11:15"]
  },
  {
    kind: "notify.driver.released",
    name: "stt_driver_released",
    category: "UTILITY",
    body: "El viaje {{1}} del {{2}} ya no est\xE1 asignado a vos. Gracias.",
    example: ["STT-AB12CD", "s\xE1bado 28/11, 10:30"]
  }
];
async function runSetup(action, args, env2, g) {
  const fail = (status, code, extra = {}) => ({ ok: false, status, body: { error: { code, ...extra } } });
  const str2 = (v, max = 100) => typeof v === "string" ? v.trim().slice(0, max) : "";
  const phone = str2(args.phoneNumberId, 30) || env2.phoneNumberId || "";
  const waba = str2(args.wabaId, 30) || env2.wabaId || "";
  if (!env2.token) return fail(503, "token_missing");
  switch (action) {
    case "status": {
      const dbg = await g("GET", `debug_token?input_token=${encodeURIComponent(env2.token)}`);
      const scopes = dbg.data?.data?.granular_scopes ?? [];
      const wabas = [...new Set(scopes.filter((s) => s.scope.startsWith("whatsapp_business")).flatMap((s) => s.target_ids ?? []))];
      const permissions = scopes.map((s) => s.scope);
      const accounts = [];
      for (const id of (waba ? [waba, ...wabas.filter((w) => w !== waba)] : wabas).slice(0, 5)) {
        const a = await g("GET", `${id}?fields=id,name,currency,timezone_id,account_review_status`);
        const p = await g("GET", `${id}/phone_numbers?fields=${PHONE_FIELDS}`);
        accounts.push({ ...a.ok ? a.data : { id, error: metaError(a.data) }, phoneNumbers: p.ok ? p.data?.data ?? [] : [] });
      }
      let calling = null;
      if (phone) {
        const s = await g("GET", `${phone}/settings`);
        calling = s.ok ? s.data?.calling ?? null : metaError(s.data);
      }
      let appWebhook = null;
      const appId = dbg.data?.data?.app_id;
      if (appId && env2.appSecret) {
        try {
          const r = await (env2.fetchImpl ?? fetch)(`https://graph.facebook.com/${GRAPH_VERSION}/${appId}/subscriptions?access_token=${encodeURIComponent(`${appId}|${env2.appSecret}`)}`);
          const j = await r.json().catch(() => ({}));
          const sub = (j?.data ?? []).find((x) => x.object === "whatsapp_business_account");
          appWebhook = { fields: (sub?.fields ?? []).map((f) => f.name ?? f), defaultCallback: sub?.callback_url ?? null };
        } catch {
          appWebhook = null;
        }
      }
      const me = await g("GET", "me?fields=id,name");
      const discovered = {};
      if (me.ok && me.data?.id) {
        const a = await g("GET", `${me.data.id}/assigned_whatsapp_business_accounts?fields=id,name`);
        discovered.assigned = a.ok ? a.data?.data ?? [] : metaError(a.data);
        const b = await g("GET", `${me.data.id}/businesses?fields=id,name`);
        const biz = b.ok ? (b.data?.data ?? []).slice(0, 3) : [];
        if (!b.ok) discovered.businessesError = metaError(b.data);
        discovered.businesses = [];
        for (const x of biz) {
          const o = await g("GET", `${x.id}/owned_whatsapp_business_accounts?fields=id,name`);
          const c = await g("GET", `${x.id}/client_whatsapp_business_accounts?fields=id,name`);
          discovered.businesses.push({
            id: x.id,
            name: x.name,
            owned: o.ok ? o.data?.data ?? [] : metaError(o.data),
            client: c.ok ? c.data?.data ?? [] : metaError(c.data)
          });
        }
      }
      return { ok: true, status: 200, body: {
        appWebhook,
        tokenOwner: me.ok ? me.data : metaError(me.data),
        discovered,
        tokenScopes: scopes.map((s) => ({ scope: s.scope, targets: s.target_ids ?? null })),
        tokenValid: !!dbg.data?.data?.is_valid,
        appId: dbg.data?.data?.app_id ?? null,
        expiresAt: dbg.data?.data?.expires_at ?? null,
        permissions,
        accounts,
        selected: { wabaId: waba || null, phoneNumberId: phone || null },
        calling,
        callbackUrl: env2.callbackUrl
      } };
    }
    case "add_number": {
      const cc = str2(args.countryCode, 4).replace(/\D/g, "");
      const number = str2(args.phoneNumber, 20).replace(/\D/g, "");
      const name = str2(args.displayName, 60);
      if (!waba) return fail(422, "waba_required");
      if (!cc || number.length < 6 || name.length < 3) return fail(422, "invalid_number");
      const r = await g("POST", `${waba}/phone_numbers`, { cc, phone_number: number, verified_name: name });
      return r.ok ? { ok: true, status: 200, body: { phoneNumberId: r.data.id }, save: { phoneNumberId: r.data.id, wabaId: waba } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "request_code": {
      if (!phone) return fail(422, "phone_required");
      const method = args.method === "VOICE" ? "VOICE" : "SMS";
      const r = await g("POST", `${phone}/request_code`, { code_method: method, language: str2(args.language, 10) || "es" });
      return r.ok ? { ok: true, status: 200, body: { sent: true, method } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "verify_code": {
      const code = str2(args.code, 10).replace(/\D/g, "");
      if (!phone || code.length !== 6) return fail(422, "invalid_code");
      const r = await g("POST", `${phone}/verify_code`, { code });
      return r.ok ? { ok: true, status: 200, body: { verified: true } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "register": {
      const pin = str2(args.pin, 10).replace(/\D/g, "");
      if (!phone || pin.length !== 6) return fail(422, "invalid_pin");
      const r = await g("POST", `${phone}/register`, { messaging_product: "whatsapp", pin });
      return r.ok ? { ok: true, status: 200, body: { registered: true }, save: { phoneNumberId: phone, ...waba ? { wabaId: waba } : {} } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "use_number": {
      if (!phone) return fail(422, "phone_required");
      const r = await g("GET", `${phone}?fields=${PHONE_FIELDS}`);
      return r.ok ? { ok: true, status: 200, body: { number: r.data }, save: { phoneNumberId: phone, ...waba ? { wabaId: waba } : {} } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "webhook": {
      if (!phone) return fail(422, "phone_required");
      if (!env2.verifyToken) return fail(503, "verify_token_missing");
      if (waba) {
        const sub = await g("POST", `${waba}/subscribed_apps`);
        if (!sub.ok) return fail(400, "meta_error", { step: "subscribe_app", meta: metaError(sub.data) });
      }
      const r = await g("POST", phone, { webhook_configuration: { override_callback_uri: env2.callbackUrl, verify_token: env2.verifyToken } });
      if (!r.ok) return fail(400, "meta_error", { step: "override_callback", meta: metaError(r.data) });
      const check = await g("GET", `${phone}?fields=webhook_configuration`);
      return { ok: true, status: 200, body: { webhook: check.data?.webhook_configuration ?? null } };
    }
    case "calling": {
      if (!phone) return fail(422, "phone_required");
      const enable = args.enable !== false;
      const r = await g("POST", `${phone}/settings`, { calling: enable ? { status: "ENABLED", call_icon_visibility: "DEFAULT", sip: { status: "DISABLED" } } : { status: "DISABLED" } });
      if (!r.ok) return fail(400, "meta_error", { meta: metaError(r.data) });
      const s = await g("GET", `${phone}/settings`);
      return { ok: true, status: 200, body: { calling: s.data?.calling ?? null } };
    }
    case "test_send": {
      if (!phone) return fail(422, "phone_required");
      const to = str2(args.to, 20).replace(/\D/g, "");
      if (to.length < 8) return fail(422, "to_required");
      const r = await g("POST", `${phone}/messages`, {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } }
      });
      return r.ok ? { ok: true, status: 200, body: { sent: r.data } } : fail(400, "meta_error", { meta: metaError(r.data) });
    }
    case "templates": {
      if (!waba) return fail(422, "waba_required");
      const existing = await g("GET", `${waba}/message_templates?fields=name,status,language&limit=200`);
      const have = new Map((existing.data?.data ?? []).map((t) => [t.name, t]));
      const results = [];
      const map = {};
      for (const t of TEMPLATES) {
        const ex = have.get(t.name);
        if (ex) {
          results.push({ kind: t.kind, name: t.name, status: ex.status });
          map[t.kind] = { name: t.name, language: ex.language };
          continue;
        }
        const r = await g("POST", `${waba}/message_templates`, {
          name: t.name,
          language: "es_AR",
          category: t.category,
          components: [
            { type: "BODY", text: t.body, example: { body_text: [t.example] } },
            ...t.buttons ? [{ type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })) }] : []
          ]
        });
        if (r.ok) {
          results.push({ kind: t.kind, name: t.name, status: r.data.status ?? "PENDING" });
          map[t.kind] = { name: t.name, language: "es_AR" };
        } else results.push({ kind: t.kind, name: t.name, status: "ERROR", error: metaError(r.data) });
      }
      return { ok: true, status: 200, body: { templates: results }, save: { templates: map } };
    }
  }
  return fail(400, "unknown_action");
}

// supabase/functions/_shared/secrets.ts
function secretSource(db2, env2, ttlMs = 3e4) {
  let vault = {};
  let at = 0;
  return {
    async refresh(force = false) {
      if (!force && Date.now() - at < ttlMs) return;
      at = Date.now();
      try {
        const { data, error } = await db2.rpc("secrets_for_functions");
        if (!error && data && typeof data === "object") vault = data;
      } catch {
      }
    },
    get(name) {
      return env2(name) || vault[name] || "";
    }
  };
}

// supabase/functions/_shared/whatsapp/copy.ts
var es = {
  welcome: '\xA1Hola{name}! \u{1F695} Soy el asistente de *SoyTuTaxi*. Reservo traslados entre Ezeiza o Aeroparque y la ciudad, con tarifa fija.\n\nPod\xE9s escribirme todo junto, por ejemplo: _"Llego a Ezeiza ma\xF1ana 10:30 en AR1303, voy a Palermo, somos 2 con 2 valijas"_.',
  nPayDue: "\u{1F695} *\xA1Tenemos chofer para {ref}!*\n\n{route}\n\u{1F5D3}\uFE0F {when}\n\nPara confirmarlo, pag\xE1 *{price}* con Mercado Pago (el chofer queda reservado unos minutos):\n{url}",
  nPickupChanged: "\u{1F552} *Cambi\xF3 el horario de b\xFAsqueda de {ref}*\n\nSeg\xFAn tu vuelo, ahora te buscamos el {when}.\n\nDetalle: {url}",
  nDriverPickupChanged: "\u{1F552} *{ref}*: nueva hora de b\xFAsqueda {when} (vuelo {flight}).",
  nRefund: "\u{1F4B8} Procesamos el reembolso de tu reserva *{ref}*. Puede tardar unos d\xEDas h\xE1biles en verse en tu medio de pago.",
  nConfirmed: "\u2705 *Tu viaje {ref} est\xE1 confirmado*\n\n{route}\n\u{1F5D3}\uFE0F {when}\n\u{1F698} {driver} \xB7 {vehicle} \xB7 {plate}\n\nVer estado: {url}",
  nCancelled: "\u274C Tu reserva *{ref}* fue cancelada. Si es un error, respond\xE9 este mensaje y te ayudamos.",
  nOffer: "\u{1F695} *Nueva oferta {ref}*\n{route}\n\u{1F5D3}\uFE0F {when}\n\u{1F465} {pax} \xB7 \u{1F9F3} {bags}\n\u{1F4B0} Gan\xE1s *{earn}*\n\u23F3 Respond\xE9 antes de las {expires}",
  btnAccept: "\u2705 Aceptar",
  btnDecline: "\u274C Rechazar",
  nAssigned: "\u{1F4CB} *Viaje asignado {ref}*\n{route}\n\u{1F5D3}\uFE0F {when}\nDetalles en la app: {url}",
  nReleased: "\u21A9\uFE0F El viaje *{ref}* se quit\xF3 de tu agenda.",
  menuShort: "\xBFEn qu\xE9 te ayudo?",
  menuBook: "\u{1F695} Reservar",
  menuCheck: "\u{1F50E} Mi reserva",
  menuStaff: "\u{1F464} Hablar c/ alguien",
  langHint: "Write in English? Reply *EN*.",
  askDirection: "\xBFTu viaje es *desde* el aeropuerto o *hacia* el aeropuerto?",
  btnFrom: "\u2708\uFE0F\u2192\u{1F3D9}\uFE0F Desde aerop.",
  btnTo: "\u{1F3D9}\uFE0F\u2192\u2708\uFE0F Hacia aerop.",
  askAirport: "\xBFQu\xE9 aeropuerto?",
  btnEZE: "Ezeiza (EZE)",
  btnAEP: "Aeroparque (AEP)",
  askZone: "\xBFEn qu\xE9 zona de la ciudad es {endpoint}?",
  zoneButton: "Elegir zona",
  endpointFrom: "el destino",
  endpointTo: "la b\xFAsqueda",
  askAddress: "\xBFCu\xE1l es la direcci\xF3n o el hotel en *{zone}*? (calle y n\xFAmero, o nombre del hotel)\nTambi\xE9n pod\xE9s mandar tu ubicaci\xF3n \u{1F4CD}",
  askDate: "\xBFQu\xE9 d\xEDa {what}?",
  dateFrom: "lleg\xE1s",
  dateTo: "viaj\xE1s",
  btnToday: "Hoy",
  btnTomorrow: "Ma\xF1ana",
  dateHint: "O escrib\xED la fecha, ej. *28/11*",
  askDateWhich: "\xBFQu\xE9 fecha quisiste decir?",
  askTimeFrom: "\xBFA qu\xE9 hora *aterriza* tu vuelo? (hora programada, ej. *14:30*)",
  askTimeTo: "\xBFA qu\xE9 hora te buscamos? (ej. *06:15*)",
  askFlight: "\xBFCu\xE1l es el n\xFAmero de vuelo? (ej. *AR1303*). Lo seguimos y ajustamos la b\xFAsqueda si se demora.",
  askPassengers: "\xBFCu\xE1ntos pasajeros?",
  paxButton: "Pasajeros",
  askBags: "\xBFCu\xE1ntas *valijas grandes*?",
  bagsButton: "Valijas",
  askCarry: "\xBFY cu\xE1ntos *bolsos de mano*?",
  carryButton: "De mano",
  badDate: "No entend\xED la fecha \u{1F914} Escribila as\xED: *28/11*.",
  pastDate: "Esa fecha ya pas\xF3. \xBFQu\xE9 d\xEDa viaj\xE1s?",
  tooFar: "Solo tomamos reservas hasta {days} d\xEDas adelante.",
  badTime: "No entend\xED la hora. Escribila as\xED: *14:30*.",
  badFlight: "Ese n\xFAmero de vuelo no parece v\xE1lido. Ej.: *AR1303*, *LA4521*.",
  tooSoon: "Necesitamos al menos {hours} h de anticipaci\xF3n \u23F1\uFE0F Eleg\xED otro horario, o escrib\xED *staff* y te ayuda una persona.",
  outside: "Esa ubicaci\xF3n est\xE1 fuera de nuestras zonas. Eleg\xED la zona m\xE1s cercana o escrib\xED *staff*.",
  noVehicle: "Para {pax} pasajeros y ese equipaje necesitamos cotizar a mano. Te contacta una persona del equipo \u{1F64C}",
  manual: "Para ese recorrido la tarifa se cotiza a mano. Ya avis\xE9 al equipo y te escriben por ac\xE1 en breve \u{1F64C}",
  review: "*Revis\xE1 tu viaje* \u{1F4DD}\n\n\u{1F6EB} {route}\n\u{1F4C5} {when}\n{flight}\u{1F465} {people}\n\u{1F697} {vehicle}\n\n\u{1F4B5} *Total: {price}*{demo}\n_Precio v\xE1lido {mins} min._",
  pickupNote: "\n_Te esperamos {buffer} min despu\xE9s del aterrizaje._",
  demo: " (tarifa de prueba)",
  btnConfirm: "\u2705 Confirmar",
  btnChange: "\u270F\uFE0F Cambiar",
  btnStaff: "\u{1F464} Staff",
  askChange: "\xBFQu\xE9 quer\xE9s cambiar?",
  changeButton: "Cambiar",
  chRoute: "Recorrido",
  chWhen: "Fecha y hora",
  chFlight: "Vuelo",
  chPeople: "Pasajeros y equipaje",
  chVehicle: "Veh\xEDculo",
  chCancel: "Cancelar todo",
  askVehicle: "Eleg\xED el veh\xEDculo:",
  vehButton: "Veh\xEDculos",
  askName: "\xBFA nombre de qui\xE9n hacemos la reserva?",
  btnUseName: 'Usar "{name}"',
  askPay: "\xBFC\xF3mo vas a pagar?",
  payHint: "Toc\xE1 uno de los botones de abajo, o escrib\xED *online* o *efectivo*.",
  pay_prepaid: "\u{1F4B3} Pago online",
  pay_pay_on_pickup_cash: "\u{1F4B5} Efectivo chofer",
  pay_pay_on_pickup_card: "\u{1F4B3} Tarjeta chofer",
  payNote: "Con pago online te enviamos el link cuando un chofer acepte el viaje.",
  booked: "\u2705 *Recibimos tu solicitud {ref}*\n\nTodav\xEDa *no est\xE1 confirmada*: estamos asignando un chofer y te avisamos por ac\xE1 apenas se confirme.\n\nVer estado: {url}",
  repriced: "El precio anterior venci\xF3; lo actualic\xE9 \u{1F447}",
  staffOn: "Listo, una persona del equipo te responde por ac\xE1 en breve \u{1F64C}",
  staffWait: "Ya avisamos al equipo; en breve te responde una persona.",
  cancelled: "Listo, empezamos de nuevo.",
  noBookings: "No encontr\xE9 reservas activas con este n\xFAmero.",
  bookingsHeader: "Tus reservas:",
  bookingLine: "\u2022 *{ref}* \u2014 {when} \u2014 {route} \u2014 {state}\n  {url}",
  state_needs_driver: "buscando chofer",
  state_held: "chofer reservado",
  state_confirmed: "confirmada \u2705",
  state_cancelled: "cancelada",
  state_requested: "solicitada",
  state_closed: "finalizada",
  unsupported: "Por ahora entiendo texto, botones y ubicaci\xF3n \u{1F4CD}. Escribime los datos del viaje.",
  error: "Uy, algo fall\xF3 de nuestro lado. Prob\xE1 de nuevo o escrib\xED *staff*.",
  people: "{pax} pas. \xB7 {bags} valijas \xB7 {carry} de mano",
  routeFrom: "{airport} \u2192 {place}",
  routeTo: "{place} \u2192 {airport}",
  driverHello: "Hola {name} \u{1F44B} Las ofertas de viajes te llegan por ac\xE1. Para tus trabajos, turnos y la bolsa us\xE1 la app: {url}",
  offerAccepted: "\u2705 \xA1El viaje {ref} es tuyo! Mir\xE1 los detalles en la app: {url}",
  offerDeclined: "Listo, rechazaste la oferta.",
  offerTaken: "Otro chofer tom\xF3 ese viaje primero.",
  offerExpired: "Esa oferta ya venci\xF3.",
  offerError: "No se pudo tomar el viaje: {reason}",
  nReminder: "\u23F0 *Recordatorio de tu viaje {ref}*\n\n{route}\n\u{1F5D3}\uFE0F {when}{driver}\n\nSi necesit\xE1s cambiar o cancelar, respond\xE9 ac\xE1 o entr\xE1 a: {url}",
  nReminderDriver: "\n\u{1F698} {driver} \xB7 {vehicle} \xB7 {plate}",
  nRating: "\u{1F64F} \xA1Gracias por viajar con SoyTuTaxi! \xBFC\xF3mo estuvo tu viaje *{ref}*?",
  rateButton: "Calificar",
  rate_5: "\u2B50\u2B50\u2B50\u2B50\u2B50 Excelente",
  rate_4: "\u2B50\u2B50\u2B50\u2B50 Muy bueno",
  rate_3: "\u2B50\u2B50\u2B50 Bien",
  rate_2: "\u2B50\u2B50 Regular",
  rate_1: "\u2B50 Malo",
  rateThanks: "\xA1Gracias por tu calificaci\xF3n! \u{1F64C}",
  rateAskComment: "Lamentamos que no haya salido bien \u{1F614} \xBFNos cont\xE1s qu\xE9 pas\xF3? Lo lee una persona del equipo.",
  rateCommentThanks: "Gracias por contarnos. Alguien del equipo lo va a revisar y, si hace falta, te escribe.",
  rateError: "No pude guardar la calificaci\xF3n ({reason}).",
  btnCancelRef: "\u274C Cancelar {ref}",
  cancelAsk: "\xBFQuer\xE9s cancelar la reserva *{ref}* ({when})?\n\n{refund}",
  cancelFree: "Es sin cargo.",
  cancelRefundFull: "Te devolvemos el total pagado ({amount}).",
  cancelRefundPart: "Seg\xFAn la pol\xEDtica de cancelaci\xF3n (menos de {hours} h antes) te devolvemos el {pct}% ({amount}).",
  cancelNoRefund: "Faltan menos de {hours} h: seg\xFAn la pol\xEDtica de cancelaci\xF3n no hay reembolso.",
  btnCancelYes: "S\xED, cancelar",
  btnCancelNo: "No, mantener",
  cancelKept: "Perfecto, tu reserva sigue en pie \u{1F44D}",
  cancelDone: "\u2705 Listo, cancelamos la reserva *{ref}*.",
  cancelDoneRefund: "\u2705 Listo, cancelamos la reserva *{ref}*. El reembolso de {amount} se procesa autom\xE1ticamente; puede tardar unos d\xEDas h\xE1biles.",
  cancelRefused: "No puedo cancelar *{ref}* por ac\xE1: {why}. Escrib\xED *staff* y te ayuda una persona.",
  why_driver_on_the_way: "el chofer ya est\xE1 en camino",
  why_trip_started: "el viaje ya empez\xF3",
  why_already_cancelled: "ya estaba cancelada",
  why_already_closed: "el viaje ya termin\xF3",
  why_booking_not_found: "no encuentro esa reserva con este n\xFAmero"
};
var en = {
  welcome: `Hi{name}! \u{1F695} I'm the *SoyTuTaxi* assistant. I book fixed-fare transfers between Ezeiza or Aeroparque and the city.

You can send everything at once, e.g. _"Landing at Ezeiza tomorrow 10:30 on AR1303, going to Palermo, 2 people with 2 suitcases"_.`,
  nPayDue: "\u{1F695} *We have a driver for {ref}!*\n\n{route}\n\u{1F5D3}\uFE0F {when}\n\nTo confirm, pay *{price}* with Mercado Pago (the driver is held for a few minutes):\n{url}",
  nPickupChanged: "\u{1F552} *Pickup time changed for {ref}*\n\nBased on your flight, we'll now meet you on {when}.\n\nDetails: {url}",
  nDriverPickupChanged: "\u{1F552} *{ref}*: new pickup time {when} (flight {flight}).",
  nRefund: "\u{1F4B8} We've processed the refund for your booking *{ref}*. It can take a few business days to show on your payment method.",
  nConfirmed: "\u2705 *Your trip {ref} is confirmed*\n\n{route}\n\u{1F5D3}\uFE0F {when}\n\u{1F698} {driver} \xB7 {vehicle} \xB7 {plate}\n\nStatus: {url}",
  nCancelled: "\u274C Your booking *{ref}* was cancelled. If that's a mistake, reply here and we'll help.",
  nOffer: "\u{1F695} *New offer {ref}*\n{route}\n\u{1F5D3}\uFE0F {when}\n\u{1F465} {pax} \xB7 \u{1F9F3} {bags}\n\u{1F4B0} You earn *{earn}*\n\u23F3 Reply before {expires}",
  btnAccept: "\u2705 Accept",
  btnDecline: "\u274C Decline",
  nAssigned: "\u{1F4CB} *Trip assigned {ref}*\n{route}\n\u{1F5D3}\uFE0F {when}\nDetails in the app: {url}",
  nReleased: "\u21A9\uFE0F Trip *{ref}* was removed from your schedule.",
  menuShort: "How can I help?",
  menuBook: "\u{1F695} Book a transfer",
  menuCheck: "\u{1F50E} My booking",
  menuStaff: "\u{1F464} Talk to a person",
  langHint: "\xBFPrefer\xEDs espa\xF1ol? Respond\xE9 *ES*.",
  askDirection: "Is your trip *from* the airport or *to* the airport?",
  btnFrom: "\u2708\uFE0F\u2192\u{1F3D9}\uFE0F From airport",
  btnTo: "\u{1F3D9}\uFE0F\u2192\u2708\uFE0F To airport",
  askAirport: "Which airport?",
  btnEZE: "Ezeiza (EZE)",
  btnAEP: "Aeroparque (AEP)",
  askZone: "Which city area is {endpoint} in?",
  zoneButton: "Choose area",
  endpointFrom: "your destination",
  endpointTo: "your pickup",
  askAddress: "What's the address or hotel in *{zone}*? (street and number, or hotel name)\nYou can also share your location \u{1F4CD}",
  askDate: "What day {what}?",
  dateFrom: "do you land",
  dateTo: "is your pickup",
  btnToday: "Today",
  btnTomorrow: "Tomorrow",
  dateHint: "Or type the date, e.g. *Nov 28*",
  askDateWhich: "Which date did you mean?",
  askTimeFrom: "What time does your flight *land*? (scheduled, e.g. *2:30pm*)",
  askTimeTo: "What time should we pick you up? (e.g. *6:15am*)",
  askFlight: "What's your flight number? (e.g. *AR1303*). We track it and adjust pickup if it's late.",
  askPassengers: "How many passengers?",
  paxButton: "Passengers",
  askBags: "How many *large suitcases*?",
  bagsButton: "Suitcases",
  askCarry: "And how many *carry-on bags*?",
  carryButton: "Carry-on",
  badDate: "I didn't get the date \u{1F914} Try *Nov 28* or *2026-11-28*.",
  pastDate: "That date has passed. What day are you travelling?",
  tooFar: "We take bookings up to {days} days ahead.",
  badTime: "I didn't get the time. Try *14:30* or *2:30pm*.",
  badFlight: "That flight number doesn't look right. E.g. *AR1303*, *LA4521*.",
  tooSoon: "We need at least {hours} h notice \u23F1\uFE0F Pick another time, or type *staff* for a person.",
  outside: "That location is outside our service areas. Choose the nearest area or type *staff*.",
  noVehicle: "For {pax} passengers and that luggage we need a manual quote. Someone from the team will message you \u{1F64C}",
  manual: "That route is quoted manually. I've told the team and they'll message you here shortly \u{1F64C}",
  review: "*Review your trip* \u{1F4DD}\n\n\u{1F6EB} {route}\n\u{1F4C5} {when}\n{flight}\u{1F465} {people}\n\u{1F697} {vehicle}\n\n\u{1F4B5} *Total: {price}*{demo}\n_Price held for {mins} min._",
  pickupNote: "\n_Your driver meets you {buffer} min after landing._",
  demo: " (test fare)",
  btnConfirm: "\u2705 Confirm",
  btnChange: "\u270F\uFE0F Change",
  btnStaff: "\u{1F464} Staff",
  askChange: "What would you like to change?",
  changeButton: "Change",
  chRoute: "Route",
  chWhen: "Date and time",
  chFlight: "Flight",
  chPeople: "Passengers & bags",
  chVehicle: "Vehicle",
  chCancel: "Start over",
  askVehicle: "Choose a vehicle:",
  vehButton: "Vehicles",
  askName: "Whose name is the booking under?",
  btnUseName: 'Use "{name}"',
  askPay: "How would you like to pay?",
  payHint: "Tap one of the buttons below, or type *online* or *cash*.",
  pay_prepaid: "\u{1F4B3} Pay online",
  pay_pay_on_pickup_cash: "\u{1F4B5} Cash to driver",
  pay_pay_on_pickup_card: "\u{1F4B3} Card to driver",
  payNote: "For online payment we send the link once a driver accepts the trip.",
  booked: "\u2705 *We've received your request {ref}*\n\nIt is *not confirmed yet*: we're assigning a driver and will message you here as soon as it's confirmed.\n\nStatus: {url}",
  repriced: "The previous price expired; here's the updated one \u{1F447}",
  staffOn: "OK \u2014 someone from the team will reply here shortly \u{1F64C}",
  staffWait: "The team has been notified; a person will reply shortly.",
  cancelled: "OK, let's start again.",
  noBookings: "I couldn't find active bookings for this number.",
  bookingsHeader: "Your bookings:",
  bookingLine: "\u2022 *{ref}* \u2014 {when} \u2014 {route} \u2014 {state}\n  {url}",
  state_needs_driver: "finding a driver",
  state_held: "driver reserved",
  state_confirmed: "confirmed \u2705",
  state_cancelled: "cancelled",
  state_requested: "requested",
  state_closed: "completed",
  unsupported: "For now I understand text, buttons and location \u{1F4CD}. Please type your trip details.",
  error: "Oops, something failed on our side. Please try again or type *staff*.",
  people: "{pax} pax \xB7 {bags} suitcases \xB7 {carry} carry-on",
  routeFrom: "{airport} \u2192 {place}",
  routeTo: "{place} \u2192 {airport}",
  driverHello: "Hi {name} \u{1F44B} Trip offers arrive here. For jobs, shifts and the job board use the app: {url}",
  offerAccepted: "\u2705 Trip {ref} is yours! See details in the app: {url}",
  offerDeclined: "OK, offer declined.",
  offerTaken: "Another driver took that trip first.",
  offerExpired: "That offer has expired.",
  offerError: "Couldn't take the trip: {reason}",
  nReminder: "\u23F0 *Reminder for your trip {ref}*\n\n{route}\n\u{1F5D3}\uFE0F {when}{driver}\n\nNeed to change or cancel? Reply here or open: {url}",
  nReminderDriver: "\n\u{1F698} {driver} \xB7 {vehicle} \xB7 {plate}",
  nRating: "\u{1F64F} Thanks for riding with SoyTuTaxi! How was your trip *{ref}*?",
  rateButton: "Rate",
  rate_5: "\u2B50\u2B50\u2B50\u2B50\u2B50 Excellent",
  rate_4: "\u2B50\u2B50\u2B50\u2B50 Very good",
  rate_3: "\u2B50\u2B50\u2B50 Good",
  rate_2: "\u2B50\u2B50 Fair",
  rate_1: "\u2B50 Poor",
  rateThanks: "Thanks for your rating! \u{1F64C}",
  rateAskComment: "Sorry it didn't go well \u{1F614} Could you tell us what happened? A person on the team reads this.",
  rateCommentThanks: "Thanks for telling us. Someone on the team will review it and get back to you if needed.",
  rateError: "I couldn't save the rating ({reason}).",
  btnCancelRef: "\u274C Cancel {ref}",
  cancelAsk: "Do you want to cancel booking *{ref}* ({when})?\n\n{refund}",
  cancelFree: "There's no charge.",
  cancelRefundFull: "We'll refund the full amount paid ({amount}).",
  cancelRefundPart: "Under the cancellation policy (less than {hours} h before) we refund {pct}% ({amount}).",
  cancelNoRefund: "It's less than {hours} h before pickup: under the cancellation policy there's no refund.",
  btnCancelYes: "Yes, cancel",
  btnCancelNo: "No, keep it",
  cancelKept: "Great, your booking stays as it is \u{1F44D}",
  cancelDone: "\u2705 Done, booking *{ref}* is cancelled.",
  cancelDoneRefund: "\u2705 Done, booking *{ref}* is cancelled. The {amount} refund is processed automatically; it can take a few business days.",
  cancelRefused: "I can't cancel *{ref}* here: {why}. Type *staff* and a person will help.",
  why_driver_on_the_way: "the driver is already on the way",
  why_trip_started: "the trip has already started",
  why_already_cancelled: "it was already cancelled",
  why_already_closed: "the trip has finished",
  why_booking_not_found: "I can't find that booking for this number"
};
function say(locale, key, vars = {}) {
  let s = (locale === "en" ? en : es)[key];
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// supabase/functions/_shared/whatsapp/parse.ts
var strip = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
var MONTHS = {
  ene: 1,
  enero: 1,
  jan: 1,
  january: 1,
  feb: 2,
  febrero: 2,
  february: 2,
  mar: 3,
  marzo: 3,
  march: 3,
  abr: 4,
  abril: 4,
  apr: 4,
  april: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  june: 6,
  jul: 7,
  julio: 7,
  july: 7,
  ago: 8,
  agosto: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  septiembre: 9,
  setiembre: 9,
  september: 9,
  oct: 10,
  octubre: 10,
  october: 10,
  nov: 11,
  noviembre: 11,
  november: 11,
  dic: 12,
  diciembre: 12,
  dec: 12,
  december: 12
};
var iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function withYear(today, m, d) {
  const y = Number(today.slice(0, 4));
  const a = iso(y, m, d);
  if (!isValidLocalDate(a)) return null;
  return a >= today ? a : isValidLocalDate(iso(y + 1, m, d)) ? iso(y + 1, m, d) : null;
}
function parseDate(text, today, locale) {
  const t = strip(text);
  if (/\bpasado manana\b|\bday after tomorrow\b/.test(t)) return { date: addDaysLocal(today, 2) };
  if (/\bmanana\b|\btomorrow\b|\btmrw\b/.test(t)) return { date: addDaysLocal(today, 1) };
  if (/\bhoy\b|\btoday\b|\btonight\b|\besta noche\b/.test(t)) return { date: today };
  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) {
    const d = iso(+m[1], +m[2], +m[3]);
    return isValidLocalDate(d) ? { date: d } : null;
  }
  for (const x of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:de\s+)?([a-z]{3,10})\b/g)) {
    if (MONTHS[x[2]]) {
      const d = withYear(today, MONTHS[x[2]], +x[1]);
      return d ? { date: d } : null;
    }
  }
  for (const x of t.matchAll(/\b([a-z]{3,10})\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    if (MONTHS[x[1]]) {
      const d = withYear(today, MONTHS[x[1]], +x[2]);
      return d ? { date: d } : null;
    }
  }
  m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (m) {
    const a = +m[1], b = +m[2];
    const year = m[3] ? m[3].length === 2 ? 2e3 + +m[3] : +m[3] : null;
    const mk = (mo, d) => year ? isValidLocalDate(iso(year, mo, d)) ? iso(year, mo, d) : null : withYear(today, mo, d);
    const dayFirst = mk(b, a), monthFirst = mk(a, b);
    if (locale === "en" && dayFirst && monthFirst && dayFirst !== monthFirst) return { options: [dayFirst, monthFirst] };
    const pick = locale === "en" ? monthFirst ?? dayFirst : dayFirst ?? monthFirst;
    return pick ? { date: pick } : null;
  }
  return null;
}
function parseTime(text) {
  const t = strip(text);
  let m = /\b([01]?\d|2[0-3])[:.h]([0-5]\d)\s*(am|pm|a\.?m\.?|p\.?m\.?)?\b/.exec(t);
  if (m) return fmt2(+m[1], +m[2], m[3]);
  m = /\b(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(t);
  if (m) return fmt2(+m[1], 0, m[2]);
  m = /\b([01]?\d|2[0-3])\s*(?:hs|hrs|h)\b/.exec(t);
  if (m) return fmt2(+m[1], 0);
  m = /\ba las\s+([01]?\d|2[0-3])\b/.exec(t);
  if (m) return fmt2(+m[1], 0);
  m = /^\s*([01]?\d|2[0-3])\s*$/.exec(t);
  if (m) return fmt2(+m[1], 0);
  return null;
}
function fmt2(h, min, ampm) {
  const ap = ampm?.replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
var NOT_AIRLINES = /* @__PURE__ */ new Set(["AT", "TO", "ON", "IN", "BY", "ME", "MY", "US", "WE", "AL", "EL", "DE", "EN", "UN", "SI", "NO", "OR", "AS", "IS", "IT", "OF", "UP", "SO", "AM", "PM", "HS", "YO", "MI", "SE", "LO", "TE", "ES", "ID"]);
function parseFlight(text) {
  const up = text.toUpperCase();
  for (const x of up.matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])([A-Z]?)(\d{1,4})([A-Z]?)\b/g)) {
    const f = normalizeFlight(x[0]);
    if (FLIGHT_RE.test(f) && !NOT_AIRLINES.has(x[1])) return f;
  }
  for (const x of up.matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])[\s-](\d{2,4})([A-Z]?)\b/g)) {
    if (NOT_AIRLINES.has(x[1])) continue;
    const f = normalizeFlight(x[0]);
    if (FLIGHT_RE.test(f)) return f;
  }
  return null;
}
function parseAirport(text) {
  const t = strip(text);
  if (/\b(eze|ezeiza|ministro pistarini)\b/.test(t)) return "EZE";
  if (/\b(aep|aeroparque|jorge newbery|newbery)\b/.test(t)) return "AEP";
  return null;
}
function parseDirection(text) {
  const t = strip(text);
  if (/\b(llego|llegamos|llega|aterrizo|aterrizamos|aterriza|arrive|arriving|arrival|landing|land at|i land|we land)\b/.test(t)) return "from_airport";
  if (/\b(al aeropuerto|hacia el aeropuerto|a ezeiza|a aeroparque|para ezeiza|para aeroparque|to the airport|to eze|to aep|to ezeiza|to aeroparque|mi vuelo sale|my flight leaves|departure|departing|salgo|me voy)\b/.test(t)) return "to_airport";
  if (/\b(desde el aeropuerto|del aeropuerto|desde ezeiza|desde aeroparque|de ezeiza|de aeroparque|from the airport|from eze|from aep|from ezeiza|from aeroparque|llego|aterrizo|aterriza|arrive|arriving|arrival|landing|land at|pick me up at (the )?airport|recoger en)\b/.test(t)) return "from_airport";
  return null;
}
var ZONE_ALIASES = {
  palermo: ["palermo", "palermo soho", "palermo hollywood", "las canitas"],
  recoleta: ["recoleta", "barrio norte"],
  microcentro: ["microcentro", "retiro", "centro", "downtown", "san nicolas", "city centre", "city center", "obelisco"],
  puerto_madero: ["puerto madero"],
  belgrano: ["belgrano", "nunez", "colegiales"],
  tigre: ["tigre", "nordelta"]
};
function parseZone(text, zones) {
  const t = strip(text);
  const active = zones.filter((z) => z.active);
  const pairs = active.flatMap((z) => [...ZONE_ALIASES[z.code] ?? [], strip(z.name)].map((a) => [a, z.code])).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, code] of pairs) if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return code;
  return null;
}
function parseCount(text, kind) {
  const t = strip(text);
  const words = { un: 1, una: 1, uno: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5, seis: 6, six: 6, siete: 7, seven: 7, ocho: 8, eight: 8, nueve: 9, nine: 9, diez: 10, ten: 10 };
  const num = "(\\d{1,2}|" + Object.keys(words).join("|") + ")";
  const nouns = kind === "passengers" ? "(?:pasajeros?|personas?|people|persons?|pax|adults?|adultos?|passengers?)" : kind === "large" ? "(?:valijas?|maletas?|suitcases?|bags?|luggage|equipajes? grandes?)" : "(?:(?:equipajes? |bolsos? )?de mano|carry[- ]?ons?|hand luggage|mochilas?|backpacks?)";
  let m = new RegExp(`\\b${num}\\s+${nouns}\\b`).exec(t);
  if (!m && kind === "passengers") m = new RegExp(`\\b(?:somos|seremos|vamos|viajamos|we are|we're|were|party of|group of)\\s+${num}\\b`).exec(t);
  if (!m) return null;
  const v = /^\d+$/.test(m[1]) ? +m[1] : words[m[1]];
  return v >= 0 && v <= 60 ? v : null;
}
function detectLanguage(text) {
  const t = strip(text);
  const en2 = (t.match(/\b(hi|hello|hey|please|airport|tomorrow|today|from|to the|flight|pick|need|want|book|taxi to|people|bags|thanks|thank you|english)\b/g) ?? []).length;
  const es2 = (t.match(/\b(hola|buen[oa]s|aeropuerto|manana|hoy|desde|hacia|vuelo|quiero|necesito|reservar|personas|valijas|gracias|por favor|espanol)\b/g) ?? []).length;
  if (en2 > es2) return "en";
  if (es2 > en2) return "es-AR";
  return null;
}
var wantsStaff = (text) => /\b(humano|persona real|hablar con (una )?persona|operador|operadora|agente|hablar con alguien|atencion humana|staff|human|agent|real person|a person|speak to someone|talk to someone)\b/.test(strip(text));
var wantsMenu = (text) => /^(menu|menú|hola|hi|hello|hey|buenas|buen dia|buenos dias|buenas tardes|buenas noches|inicio|start|empezar)[!. ]*$/.test(strip(text));
var wantsCancel = (text) => /^(cancelar|cancel|salir|exit|reset|empezar de nuevo|start over)[!. ]*$/.test(strip(text));
var wantsStatus = (text) => /\b(mi reserva|estado|status|my booking|check booking|consultar)\b/.test(strip(text));
function extractAll(text, zones, today, locale) {
  const e = {};
  const dir = parseDirection(text);
  if (dir) e.direction = dir;
  const ap = parseAirport(text);
  if (ap) e.airport = ap;
  const z = parseZone(text, zones);
  if (z) e.zoneCode = z;
  const d = parseDate(text, today, locale);
  if (d?.date) e.date = d.date;
  else if (d?.options) e.dateOptions = d.options;
  const tm = parseTime(text.replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, " "));
  if (tm && !/^\s*\d{1,2}\s*$/.test(text)) e.time = tm;
  const f = parseFlight(text);
  if (f) e.flight = f;
  const p = parseCount(text, "passengers");
  if (p !== null) e.passengers = p;
  const l = parseCount(text, "large");
  if (l !== null) e.largeBags = l;
  const c = parseCount(text, "carry");
  if (c !== null) e.carryOn = c;
  const lang = detectLanguage(text);
  if (lang) e.language = lang;
  if (wantsStaff(text)) e.wantsStaff = true;
  return e;
}

// supabase/functions/_shared/whatsapp/engine.ts
var FIELD_ORDER = ["direction", "airport", "zoneCode", "placeText", "date", "time", "flight", "passengers", "largeBags", "carryOn"];
var QUOTE_FIELDS = ["direction", "airport", "zoneCode", "placeText", "lat", "lng", "date", "time", "flight", "passengers", "largeBags", "carryOn", "vehicleClass"];
function typedPayment(text, allowed) {
  const p = strip(text);
  const num = /^\s*([1-3])\s*$/.exec(p);
  if (num) return allowed[+num[1] - 1] ?? null;
  const want = /(online|on line|link|mercado ?pago|\bmp\b|internet|web|transfer|prepa)/.test(p) ? "prepaid" : /(efectivo|cash|plata|pesos|dolares|dollars)/.test(p) ? "pay_on_pickup_cash" : /(tarjeta|card|debito|credito|posnet)/.test(p) ? "pay_on_pickup_card" : null;
  if (want && allowed.includes(want)) return want;
  if (want === "pay_on_pickup_card" && allowed.includes("prepaid")) return "prepaid";
  return null;
}
var YES = /^(si|sí|s|yes|y|ok|okay|dale|confirmo|confirmar|confirm|listo|perfecto|correcto|de una)[!. ]*$/;
async function handleMessage(conv, msg, deps2) {
  const ctx = new Turn(conv, msg, deps2);
  try {
    if (conv.kind === "driver") await ctx.driver();
    else await ctx.passenger();
  } catch (e) {
    console.error(JSON.stringify({ level: "error", where: "wa-engine", conv: conv.id, error: String(e?.message ?? e).slice(0, 300) }));
    ctx.replies = [{ type: "text", text: say(ctx.locale, "error") }];
  }
  return { replies: ctx.replies, step: ctx.step, draft: ctx.draft, locale: ctx.locale, needsStaff: ctx.needsStaff, bookingId: ctx.bookingId };
}
var Turn = class {
  constructor(conv, msg, deps2) {
    this.conv = conv;
    this.msg = msg;
    this.deps = deps2;
    this.step = conv.step;
    this.draft = { ...conv.draft };
    this.locale = conv.locale;
    this.today = utcToLocalDate(deps2.now, deps2.cfg.timezone);
    this.text = msg.type === "text" ? (msg.text ?? "").trim() : "";
    this.id = msg.type === "reply" ? msg.replyId ?? "" : "";
  }
  replies = [];
  step;
  draft;
  locale;
  needsStaff;
  bookingId;
  today;
  text;
  id;
  t(key, vars = {}) {
    return say(this.locale, key, vars);
  }
  textOut(text) {
    this.replies.push({ type: "text", text });
  }
  get phone() {
    return `+${this.conv.waId}`;
  }
  // ------------------------------------------------------------------------------- drivers
  async driver() {
    const m = /^offer:([0-9a-f-]{36}):(a|d)$/.exec(this.id);
    const app = `${this.deps.publicAppUrl.replace(/\/$/, "")}/chofer`;
    if (m && this.conv.driverId && this.deps.driverRespond) {
      try {
        const r = await this.deps.driverRespond(this.conv.driverId, m[1], m[2] === "a");
        this.textOut(r.outcome === "accepted" ? this.t("offerAccepted", { ref: r.reference ?? "", url: app }) : r.outcome === "declined" ? this.t("offerDeclined") : r.outcome === "expired" ? this.t("offerExpired") : this.t("offerTaken"));
      } catch (e) {
        this.textOut(this.t("offerError", { reason: e instanceof ApiError ? e.code : "error" }));
      }
      return;
    }
    this.textOut(this.t("driverHello", { name: this.conv.profileName ?? "", url: app }));
  }
  // ------------------------------------------------------------------------------- passengers
  async passenger() {
    const plain = strip(this.text);
    if (/^(en|english|ingles)$/.test(plain) || this.id === "lang:en") {
      this.locale = "en";
      return this.resume();
    }
    if (/^(es|espanol|castellano)$/.test(plain) || this.id === "lang:es") {
      this.locale = "es-AR";
      return this.resume();
    }
    const rm = /^rate:([0-9a-f-]{36}):([1-5])$/.exec(this.id);
    if (rm && this.deps.rate) return this.rate(rm[1], +rm[2], null);
    if (this.step === "rate_comment" && this.text && this.draft.rateBooking && this.deps.rate && !wantsStaff(this.text)) {
      return this.rate(this.draft.rateBooking, this.draft.rateScore ?? 1, this.text);
    }
    const cm = /^bk:(cancel|cancelok|keep):([A-Z0-9-]{4,20})$/.exec(this.id);
    if (cm && this.deps.cancelBooking) return this.selfCancel(cm[2], cm[1]);
    if (this.id === "menu:staff" || this.id === "review:staff" || this.text && wantsStaff(this.text)) return this.handoff("staffOn");
    if (this.id === "change:cancel" || this.text && wantsCancel(this.text)) {
      this.resetDraft();
      this.textOut(this.t("cancelled"));
      return this.menu(false);
    }
    if (this.id === "menu:check" || this.text && wantsStatus(this.text) && ["menu", "done", "handoff"].includes(this.step)) return this.listBookings();
    if (this.step === "handoff" && !this.id.startsWith("menu:") && !wantsMenu(this.text)) {
      if (!this.draft.staffNotified) {
        this.draft.staffNotified = true;
        this.textOut(this.t("staffWait"));
      }
      return;
    }
    if (this.id === "menu:book") {
      this.resetDraft();
      this.step = "direction";
      return this.next();
    }
    if (this.id) return this.applyReply();
    if (this.msg.type === "location" && this.msg.location) return this.applyLocation();
    if (this.msg.type === "other") {
      this.textOut(this.t("unsupported"));
      return;
    }
    if (this.deps.assistant && !["menu", "done", "handoff", "review"].includes(this.step) && looksLikeQuestion(this.text)) {
      if (await this.askAssistant(this.step) === "handled") return this.next();
    }
    let wantsNewTrip = false;
    if (this.deps.assistant && ["menu", "done"].includes(this.step) && !wantsMenu(this.text) && this.text.trim().length >= 3) {
      const r = await this.askAssistant("none");
      if (r === "handled") return;
      wantsNewTrip = r === "book";
    }
    const extracted = await this.understand();
    if (extracted.language && ["menu", "done"].includes(this.step) && !this.hasAnyField()) this.locale = extracted.language;
    const stepBefore = this.step;
    const captured = this.applyStepText(extracted);
    if (stepBefore === "name" && captured) return this.confirm();
    if (stepBefore === "payment") {
      if (!captured && !YES.test(plain)) this.textOut(this.t("payHint"));
      return this.confirm();
    }
    const changed = this.merge(extracted);
    if (["menu", "done", "handoff"].includes(this.step) && !changed && !captured) {
      if (wantsNewTrip) {
        this.resetDraft();
        this.step = "direction";
        return this.next();
      }
      if (this.step === "done" && this.draft.lastRef && !wantsMenu(this.text)) return this.menu(false);
      return this.menu(true);
    }
    if (this.step === "review" && YES.test(plain)) return this.confirm();
    if (["menu", "done", "handoff"].includes(this.step)) this.step = "direction";
    return this.next();
  }
  /** Ask the AI assistant. Returns false when it couldn't help (the classic menu takes over). */
  async askAssistant(awaiting) {
    const memory = this.deps.customerContext ? await this.deps.customerContext(this.phone).catch(() => null) : null;
    const r = await this.deps.assistant.reply({
      text: this.text,
      locale: this.locale,
      awaiting,
      facts: operatorFacts(this.deps.cfg, this.deps.now),
      customer: customerFacts(memory, this.deps.cfg, this.locale)
    });
    if (!r) return "none";
    if (r.language && ["menu", "done"].includes(this.step)) this.locale = r.language === "en" ? "en" : "es-AR";
    if (awaiting !== "none") {
      if (r.action === "staff") {
        if (r.reply) this.textOut(r.reply);
        this.handoff("staffOn");
        return "none";
      }
      if (!r.reply) return "none";
      this.textOut(r.reply);
      return "handled";
    }
    switch (r.action) {
      case "answer":
        this.textOut(r.reply);
        if (this.step === "menu") this.step = "done";
        return "handled";
      case "bookings":
        if (r.reply) this.textOut(r.reply);
        await this.listBookings();
        return "handled";
      case "staff":
        if (r.reply) this.textOut(r.reply);
        this.handoff("staffOn");
        return "handled";
      case "cancel":
        if (r.reference && this.deps.cancelBooking) {
          if (r.reply) this.textOut(r.reply);
          await this.selfCancel(r.reference, "cancel");
          return "handled";
        }
        if (r.reply) {
          this.textOut(r.reply);
          return "handled";
        }
        return "none";
      case "book":
        if (r.reply) this.textOut(r.reply);
        return "book";
    }
    return "none";
  }
  hasAnyField() {
    return FIELD_ORDER.some((f) => this.draft[f] !== void 0);
  }
  resetDraft() {
    this.draft = { name: this.draft.name, lastRef: this.draft.lastRef, lastUrl: this.draft.lastUrl };
  }
  clearQuote() {
    delete this.draft.quoteId;
    delete this.draft.quoteExpiresAt;
    delete this.draft.options;
  }
  /** Re-ask the current question in the new language, or show the menu. */
  async resume() {
    if (["menu", "done", "handoff"].includes(this.step) || !this.hasAnyField()) return this.menu(true);
    return this.next();
  }
  menu(withWelcome) {
    this.step = "menu";
    const name = this.conv.profileName ? ` ${this.conv.profileName.split(/\s+/)[0]}` : "";
    this.replies.push({
      type: "buttons",
      text: withWelcome ? this.t("welcome", { name }) : this.t("menuShort"),
      footer: this.t("langHint"),
      buttons: [
        { id: "menu:book", title: this.t("menuBook") },
        { id: "menu:check", title: this.t("menuCheck") },
        { id: "menu:staff", title: this.t("menuStaff") }
      ]
    });
  }
  handoff(key, vars = {}) {
    this.step = "handoff";
    this.needsStaff = true;
    this.draft.staffNotified = true;
    this.textOut(this.t(key, vars));
  }
  statusUrl(reference, token) {
    return `${this.deps.publicAppUrl.replace(/\/$/, "")}/reserva/${reference}?t=${token}`;
  }
  async listBookings() {
    const list = await this.deps.bookingsForPhone(this.phone);
    if (!list.length) {
      this.textOut(this.t("noBookings"));
      return this.menu(false);
    }
    const lines = await Promise.all(list.map(async (b) => {
      const token = await deriveStatusToken(this.deps.statusTokenSecret, this.deps.cfg.operatorId, b.idempotencyKey);
      return this.t("bookingLine", {
        ref: b.reference,
        when: this.when(b.pickupAt),
        route: b.direction === "from_airport" ? `${b.airport} \u2192 ${b.zone ?? ""}` : `${b.zone ?? ""} \u2192 ${b.airport}`,
        state: this.t(`state_${b.state}`) || b.state,
        url: this.statusUrl(b.reference, token)
      });
    }));
    this.textOut(`${this.t("bookingsHeader")}

${lines.join("\n\n")}`);
    const open = list.filter((b) => !["cancelled", "closed"].includes(b.state)).slice(0, 3);
    if (this.deps.cancelBooking && open.length) {
      this.replies.push({
        type: "buttons",
        text: this.t("menuShort"),
        buttons: open.map((b) => ({ id: `bk:cancel:${b.reference}`, title: this.t("btnCancelRef", { ref: b.reference }) }))
      });
    }
    if (this.step !== "handoff") this.step = "done";
  }
  money(minor, currency) {
    return currency ? formatMoney(minor, currency, this.locale) : String(minor);
  }
  async selfCancel(reference, action) {
    this.step = "done";
    if (action === "keep") {
      this.textOut(this.t("cancelKept"));
      return;
    }
    try {
      const t = await this.deps.cancelBooking(this.phone, reference, action === "cancelok");
      if (!t.allowed && !t.cancelled) {
        this.textOut(this.t("cancelRefused", { ref: reference, why: this.t(`why_${t.reason}`) || String(t.reason) }));
        return;
      }
      if (t.cancelled) {
        this.textOut(t.refundMinor > 0 ? this.t("cancelDoneRefund", { ref: reference, amount: this.money(t.refundMinor, t.currency) }) : this.t("cancelDone", { ref: reference }));
        return;
      }
      const hours = t.freeUntilHoursBefore;
      const refund = t.paidMinor <= 0 ? t.refundPercent === 100 || t.paymentMode !== "prepaid" ? this.t("cancelFree") : this.t("cancelNoRefund", { hours }) : t.refundMinor <= 0 ? this.t("cancelNoRefund", { hours }) : t.refundPercent === 100 ? this.t("cancelRefundFull", { amount: this.money(t.refundMinor, t.currency) }) : this.t("cancelRefundPart", { hours, pct: t.refundPercent, amount: this.money(t.refundMinor, t.currency) });
      this.replies.push({
        type: "buttons",
        text: this.t("cancelAsk", { ref: reference, when: this.when(t.pickupAt), refund }),
        buttons: [{ id: `bk:cancelok:${reference}`, title: this.t("btnCancelYes") }, { id: `bk:keep:${reference}`, title: this.t("btnCancelNo") }]
      });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      this.textOut(this.t("cancelRefused", { ref: reference, why: this.t(`why_${code}`) || code }));
    }
  }
  async rate(bookingId, score, comment) {
    try {
      await this.deps.rate(this.phone, bookingId, score, comment);
      if (comment) {
        this.textOut(this.t("rateCommentThanks"));
        this.step = "done";
        delete this.draft.rateBooking;
        delete this.draft.rateScore;
      } else if (score <= 2) {
        this.textOut(this.t("rateAskComment"));
        this.step = "rate_comment";
        this.draft.rateBooking = bookingId;
        this.draft.rateScore = score;
      } else {
        this.textOut(this.t("rateThanks"));
        this.step = "done";
      }
    } catch (e) {
      this.textOut(this.t("rateError", { reason: e instanceof ApiError ? e.code : "error" }));
      this.step = "done";
      delete this.draft.rateBooking;
    }
  }
  // ------------------------------------------------------------------------------- understanding
  async understand() {
    const cfg = this.deps.cfg;
    const e = extractAll(this.text, cfg.zones, this.today, this.locale);
    const words = this.text.split(/\s+/).filter(Boolean).length;
    const useAi = this.deps.ai && words >= 4 && !["name", "address", "time", "flight"].includes(this.step);
    if (!useAi) return e;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "long" }).format(this.deps.now);
    const ai = await this.deps.ai.extract(this.text, {
      today: this.today,
      weekday,
      locale: this.locale,
      awaiting: this.step,
      zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name }))
    });
    if (!ai) return e;
    if (!e.direction && (ai.direction === "from_airport" || ai.direction === "to_airport")) e.direction = ai.direction;
    if (!e.airport && (ai.airport === "EZE" || ai.airport === "AEP")) e.airport = ai.airport;
    if (!e.zoneCode && ai.zone && cfg.zones.some((z) => z.active && z.code === ai.zone)) e.zoneCode = ai.zone;
    if (!e.placeText && ai.address && String(ai.address).trim().length >= 3) e.placeText = String(ai.address).trim().slice(0, 200);
    if (!e.date && !e.dateOptions && ai.date && parseDate(String(ai.date), this.today, "es-AR")?.date) e.date = parseDate(String(ai.date), this.today, "es-AR").date;
    if (!e.time && ai.time) {
      const tm = parseTime(String(ai.time));
      if (tm) e.time = tm;
    }
    if (!e.flight && ai.flight) {
      const f = parseFlight(String(ai.flight));
      if (f) e.flight = f;
    }
    const n = (v, max) => Number.isInteger(v) && v >= 0 && v <= max ? v : void 0;
    if (e.passengers === void 0 && n(ai.passengers, 60)) e.passengers = n(ai.passengers, 60);
    if (e.largeBags === void 0 && n(ai.large_bags, 60) !== void 0) e.largeBags = n(ai.large_bags, 60);
    if (e.carryOn === void 0 && n(ai.carry_on, 60) !== void 0) e.carryOn = n(ai.carry_on, 60);
    if (!e.language && (ai.language === "en" || ai.language === "es")) e.language = ai.language === "en" ? "en" : "es-AR";
    if (ai.wants_staff === true) e.wantsStaff = true;
    return e;
  }
  /** Text that answers exactly the question being asked (a bare number, an address, a name…). */
  applyStepText(e) {
    const t = this.text;
    switch (this.step) {
      case "address":
        if (t.length >= 3 && !e.placeText) {
          this.draft.placeText = t.slice(0, 200);
          this.clearQuote();
          return true;
        }
        return false;
      case "name":
        if (t.length >= 2) {
          this.draft.name = t.slice(0, 120);
          return true;
        }
        return false;
      case "payment": {
        const m = typedPayment(t, this.deps.cfg.policy.config.allowed_payment_modes);
        if (m) {
          this.draft.paymentMode = m;
          return true;
        }
        return false;
      }
      case "passengers":
      case "bags":
      case "carry": {
        const num = /^\s*(\d{1,2})\s*$/.exec(t);
        const key = this.step === "passengers" ? "passengers" : this.step === "bags" ? "largeBags" : "carryOn";
        const v = num ? +num[1] : parseCount(t, this.step === "passengers" ? "passengers" : this.step === "bags" ? "large" : "carry");
        if (v !== null && (this.step !== "passengers" || v >= 1)) {
          this.draft[key] = v;
          this.clearQuote();
          return true;
        }
        return false;
      }
      case "time": {
        const tm = parseTime(t);
        if (tm) {
          this.draft.time = tm;
          this.clearQuote();
          return true;
        }
        if (!e.date && !e.flight) this.textOut(this.t("badTime"));
        return false;
      }
      case "flight": {
        const f = parseFlight(t);
        if (f) {
          this.draft.flight = f;
          this.clearQuote();
          return true;
        }
        this.textOut(this.t("badFlight"));
        return false;
      }
      case "date":
      case "date_pick": {
        if (!e.date && !e.dateOptions) {
          this.textOut(this.t("badDate"));
        }
        return false;
      }
      default:
        return false;
    }
  }
  /** Merge extracted details; the passenger's latest statement wins. Returns true if anything changed. */
  merge(e) {
    let changed = false;
    const set = (k, v) => {
      if (v === void 0 || this.draft[k] === v) return;
      this.draft[k] = v;
      changed = true;
      if (QUOTE_FIELDS.includes(k)) this.clearQuote();
    };
    set("direction", e.direction);
    set("airport", e.airport);
    if (e.zoneCode && e.zoneCode !== this.draft.zoneCode) {
      delete this.draft.lat;
      delete this.draft.lng;
    }
    set("zoneCode", e.zoneCode);
    if (e.placeText && this.step !== "address") set("placeText", e.placeText);
    if (e.dateOptions) {
      this.draft.dateOptions = e.dateOptions;
      changed = true;
    }
    set("date", e.date);
    set("time", e.time);
    set("flight", e.flight);
    set("passengers", e.passengers);
    set("largeBags", e.largeBags);
    set("carryOn", e.carryOn);
    if (e.wantsStaff) {
      this.needsStaff = true;
    }
    return changed;
  }
  applyLocation() {
    const { lat, lng, name, address } = this.msg.location;
    const z = zonesContaining(lng, lat, this.deps.cfg.zones)[0];
    if (!z) {
      this.textOut(this.t("outside"));
      this.step = "zone";
      return this.next();
    }
    this.draft.zoneCode = z.code;
    this.draft.lat = lat;
    this.draft.lng = lng;
    this.draft.placeText = [name, address].filter(Boolean).join(", ").slice(0, 200) || (this.locale === "en" ? "\u{1F4CD} Shared location" : "\u{1F4CD} Ubicaci\xF3n enviada");
    this.clearQuote();
    if (["menu", "done"].includes(this.step)) this.step = "direction";
    return this.next();
  }
  async applyReply() {
    const [kind, val] = [this.id.split(":")[0], this.id.slice(this.id.indexOf(":") + 1)];
    const cfg = this.deps.cfg;
    switch (kind) {
      case "dir":
        if (val === "from_airport" || val === "to_airport") {
          this.draft.direction = val;
          this.clearQuote();
        }
        break;
      case "ap":
        if (cfg.airports.some((a) => a.active && a.iata === val)) {
          this.draft.airport = val;
          this.clearQuote();
        }
        break;
      case "zone":
        if (cfg.zones.some((z) => z.active && z.code === val)) {
          if (this.draft.zoneCode !== val) {
            delete this.draft.lat;
            delete this.draft.lng;
            delete this.draft.placeText;
          }
          this.draft.zoneCode = val;
          this.clearQuote();
        }
        break;
      case "date":
        this.draft.date = val === "today" ? this.today : val === "tomorrow" ? addDaysLocal(this.today, 1) : val;
        delete this.draft.dateOptions;
        this.clearQuote();
        break;
      case "pax":
        if (val === "more") {
          this.step = "passengers";
          this.textOut(this.t("askPassengers"));
          return;
        }
        this.draft.passengers = +val;
        this.clearQuote();
        break;
      case "bags":
        this.draft.largeBags = +val;
        this.clearQuote();
        break;
      case "carry":
        this.draft.carryOn = +val;
        this.clearQuote();
        break;
      case "review":
        if (val === "confirm") return this.confirm();
        if (val === "change") return this.askChange();
        break;
      case "change":
        if (val === "route") {
          for (const k of ["direction", "airport", "zoneCode", "placeText", "lat", "lng", "flight"]) delete this.draft[k];
        }
        if (val === "when") {
          delete this.draft.date;
          delete this.draft.time;
        }
        if (val === "flight") delete this.draft.flight;
        if (val === "people") {
          delete this.draft.passengers;
          delete this.draft.largeBags;
          delete this.draft.carryOn;
          delete this.draft.vehicleClass;
        }
        if (val === "vehicle") return this.askVehicle();
        this.clearQuote();
        break;
      case "veh":
        this.draft.vehicleClass = val;
        this.clearQuote();
        break;
      case "name":
        if (val === "profile" && this.conv.profileName) this.draft.name = this.conv.profileName.slice(0, 120);
        return this.confirm();
      case "pay":
        if (cfg.policy.config.allowed_payment_modes.includes(val)) this.draft.paymentMode = val;
        return this.confirm();
      default:
        return this.menu(true);
    }
    if (["menu", "done"].includes(this.step)) this.step = "direction";
    return this.next();
  }
  // ------------------------------------------------------------------------------- asking
  validateDate() {
    const d = this.draft.date;
    if (!d) return true;
    if (d < this.today) {
      delete this.draft.date;
      this.textOut(this.t("pastDate"));
      return false;
    }
    if (d > addDaysLocal(this.today, this.deps.cfg.policy.config.max_advance_days)) {
      delete this.draft.date;
      this.textOut(this.t("tooFar", { days: this.deps.cfg.policy.config.max_advance_days }));
      return false;
    }
    return true;
  }
  async next() {
    const d = this.draft;
    this.validateDate();
    if (d.dateOptions?.length && !d.date) {
      const max = addDaysLocal(this.today, this.deps.cfg.policy.config.max_advance_days);
      const ok = d.dateOptions.filter((o) => o >= this.today && o <= max);
      if (ok.length === 1) {
        d.date = ok[0];
        delete d.dateOptions;
      } else if (ok.length === 0) {
        delete d.dateOptions;
        this.textOut(this.t("badDate"));
        return this.ask("date");
      } else {
        d.dateOptions = ok;
        return this.askDatePick();
      }
    }
    for (const f of FIELD_ORDER) {
      if (f === "flight" && d.direction !== "from_airport") continue;
      if (d[f] === void 0 || d[f] === "") return this.ask(f);
    }
    if (!d.quoteId || this.quoteExpired()) return this.quote(!!d.quoteId);
    return this.showReview();
  }
  quoteExpired() {
    return !this.draft.quoteExpiresAt || new Date(this.draft.quoteExpiresAt) <= this.deps.now;
  }
  ask(f) {
    const cfg = this.deps.cfg, d = this.draft;
    const n = (prefix, from, to, more) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `${prefix}:${from + i}`, title: String(from + i) })).concat(more ? [{ id: `${prefix}:more`, title: "10+" }] : []);
    switch (f) {
      case "direction":
        this.step = "direction";
        this.replies.push({ type: "buttons", text: this.t("askDirection"), buttons: [
          { id: "dir:from_airport", title: this.t("btnFrom") },
          { id: "dir:to_airport", title: this.t("btnTo") },
          { id: "menu:staff", title: this.t("btnStaff") }
        ] });
        return;
      case "airport":
        this.step = "airport";
        this.replies.push({ type: "buttons", text: this.t("askAirport"), buttons: cfg.airports.filter((a) => a.active).slice(0, 3).map((a) => ({ id: `ap:${a.iata}`, title: a.iata === "EZE" ? this.t("btnEZE") : a.iata === "AEP" ? this.t("btnAEP") : a.iata })) });
        return;
      case "zoneCode":
        this.step = "zone";
        this.replies.push({
          type: "list",
          text: this.t("askZone", { endpoint: this.t(d.direction === "to_airport" ? "endpointTo" : "endpointFrom") }),
          button: this.t("zoneButton"),
          rows: cfg.zones.filter((z) => z.active).slice(0, 10).map((z) => ({ id: `zone:${z.code}`, title: z.name }))
        });
        return;
      case "placeText":
        this.step = "address";
        this.textOut(this.t("askAddress", { zone: cfg.zones.find((z) => z.code === d.zoneCode)?.name ?? "" }));
        return;
      case "date":
        this.step = "date";
        this.replies.push({
          type: "buttons",
          text: `${this.t("askDate", { what: this.t(d.direction === "to_airport" ? "dateTo" : "dateFrom") })}
${this.t("dateHint")}`,
          buttons: [{ id: "date:today", title: this.t("btnToday") }, { id: "date:tomorrow", title: this.t("btnTomorrow") }]
        });
        return;
      case "time":
        this.step = "time";
        this.textOut(this.t(d.direction === "to_airport" ? "askTimeTo" : "askTimeFrom"));
        return;
      case "flight":
        this.step = "flight";
        this.textOut(this.t("askFlight"));
        return;
      case "passengers":
        this.step = "passengers";
        this.replies.push({ type: "list", text: this.t("askPassengers"), button: this.t("paxButton"), rows: n("pax", 1, 9, true) });
        return;
      case "largeBags":
        this.step = "bags";
        this.replies.push({ type: "list", text: this.t("askBags"), button: this.t("bagsButton"), rows: n("bags", 0, 9) });
        return;
      case "carryOn":
        this.step = "carry";
        this.replies.push({ type: "list", text: this.t("askCarry"), button: this.t("carryButton"), rows: n("carry", 0, 9) });
        return;
    }
  }
  askDatePick() {
    this.step = "date_pick";
    this.replies.push({
      type: "buttons",
      text: this.t("askDateWhich"),
      buttons: this.draft.dateOptions.slice(0, 3).map((o) => ({ id: `date:${o}`, title: this.longDate(o) }))
    });
  }
  askChange() {
    this.step = "change";
    const rows = [
      { id: "change:route", title: this.t("chRoute") },
      { id: "change:when", title: this.t("chWhen") },
      ...this.draft.direction === "from_airport" ? [{ id: "change:flight", title: this.t("chFlight") }] : [],
      { id: "change:people", title: this.t("chPeople") },
      ...(this.draft.options ?? []).filter((o) => o.eligible && o.amountMinor !== null).length > 1 ? [{ id: "change:vehicle", title: this.t("chVehicle") }] : [],
      { id: "change:cancel", title: this.t("chCancel") }
    ];
    this.replies.push({ type: "list", text: this.t("askChange"), button: this.t("changeButton"), rows });
  }
  askVehicle() {
    this.step = "vehicle";
    const rows = (this.draft.options ?? []).filter((o) => o.eligible && o.amountMinor !== null).map((o) => ({
      id: `veh:${o.code}`,
      title: this.vehicleLabel(o.code),
      description: formatMoney(o.amountMinor, o.currency, this.locale)
    }));
    this.replies.push({ type: "list", text: this.t("askVehicle"), button: this.t("vehButton"), rows });
  }
  // ------------------------------------------------------------------------------- quote & review
  async quote(repriced) {
    const d = this.draft, cfg = this.deps.cfg;
    const r = computeQuote({
      direction: d.direction,
      airport: d.airport,
      zoneCode: d.zoneCode,
      place: { text: d.placeText, lat: d.lat ?? null, lng: d.lng ?? null },
      date: d.date,
      time: d.time,
      flightDesignator: d.direction === "from_airport" ? d.flight : null,
      passengers: d.passengers,
      largeBags: d.largeBags,
      carryOn: d.carryOn,
      vehicleClass: d.vehicleClass ?? null,
      locale: this.locale
    }, cfg, { now: this.deps.now });
    if (r.kind === "invalid") {
      const e = r.errors[0];
      if (e.field === "time" || e.field === "date") {
        delete d.time;
        if (e.code === "too_far_ahead") {
          delete d.date;
          this.textOut(this.t("tooFar", { days: cfg.policy.config.max_advance_days }));
        } else this.textOut(this.t("tooSoon", { hours: Math.round(cfg.policy.config.lead_time_minutes / 60) }));
      } else if (e.field === "flightDesignator") {
        delete d.flight;
        this.textOut(this.t("badFlight"));
      } else if (e.field === "vehicleClass") {
        delete d.vehicleClass;
      } else if (e.field.startsWith("place")) {
        delete d.placeText;
        delete d.lat;
        delete d.lng;
        this.textOut(this.t("outside"));
      } else if (e.field === "zoneCode") {
        delete d.zoneCode;
      } else if (["passengers", "largeBags", "carryOn"].includes(e.field)) {
        delete d[e.field];
      } else return this.handoff("staffOn");
      return this.next();
    }
    if (r.kind === "manual") {
      return r.reasons.includes("no_vehicle_fits") ? this.handoff("noVehicle", { pax: d.passengers }) : this.handoff("manual");
    }
    const expiresAt = addMinutes(this.deps.now, cfg.policy.config.quote_expiry_minutes).toISOString();
    const { id } = await this.deps.store.insertQuote({
      operatorId: cfg.operatorId,
      sessionHash: await sessionHash(`wa:${this.conv.waId}`),
      source: "whatsapp",
      kind: "priced",
      journey: r.journey,
      vehicleClass: r.vehicleClass,
      fare: r.fare,
      policyId: cfg.policy.id,
      manualReasons: [],
      expiresAt
    });
    d.quoteId = id;
    d.quoteExpiresAt = expiresAt;
    d.vehicleClass = r.vehicleClass;
    d.options = r.options;
    d.fare = { total: r.fare.totalMinor, currency: r.fare.currency, demo: r.fare.isDemo };
    d.pickupAt = r.journey.pickupAt;
    d.buffer = r.journey.flight?.bufferMinutes ?? null;
    if (repriced) this.textOut(this.t("repriced"));
    return this.showReview();
  }
  showReview() {
    const d = this.draft;
    const cfg = this.deps.cfg;
    const zone = cfg.zones.find((z) => z.code === d.zoneCode)?.name ?? "";
    const place = `${d.placeText}${zone && !d.placeText?.includes(zone) ? ` (${zone})` : ""}`;
    const route = d.direction === "from_airport" ? this.t("routeFrom", { airport: d.airport, place }) : this.t("routeTo", { airport: d.airport, place });
    const mins = Math.max(1, Math.round((new Date(d.quoteExpiresAt).getTime() - this.deps.now.getTime()) / 6e4));
    this.step = "review";
    this.replies.push({
      type: "buttons",
      text: this.t("review", {
        route,
        when: this.when(d.pickupAt),
        flight: d.flight ? `\u2708\uFE0F ${d.flight} \xB7 ${d.time}
` : "",
        people: this.t("people", { pax: d.passengers, bags: d.largeBags, carry: d.carryOn }),
        vehicle: this.vehicleLabel(d.vehicleClass),
        price: formatMoney(d.fare.total, d.fare.currency, this.locale),
        demo: d.fare.demo ? this.t("demo") : "",
        mins
      }) + (d.buffer ? this.t("pickupNote", { buffer: d.buffer }) : ""),
      buttons: [{ id: "review:confirm", title: this.t("btnConfirm") }, { id: "review:change", title: this.t("btnChange") }, { id: "review:staff", title: this.t("btnStaff") }]
    });
  }
  // ------------------------------------------------------------------------------- booking
  async confirm() {
    const d = this.draft, cfg = this.deps.cfg;
    if (!d.quoteId && this.step === "done" && d.lastRef) {
      this.textOut(this.t("booked", { ref: d.lastRef, url: d.lastUrl ?? "" }));
      return;
    }
    if (!d.quoteId) return this.next();
    if (this.quoteExpired()) return this.quote(true);
    if (!d.name) {
      this.step = "name";
      if (this.conv.profileName) {
        this.replies.push({ type: "buttons", text: this.t("askName"), buttons: [{ id: "name:profile", title: this.t("btnUseName", { name: this.conv.profileName.slice(0, 10) }) }] });
      } else this.textOut(this.t("askName"));
      return;
    }
    const modes = cfg.policy.config.allowed_payment_modes;
    if (!d.paymentMode) {
      if (modes.length === 1) d.paymentMode = modes[0];
      else {
        this.step = "payment";
        this.replies.push({
          type: "buttons",
          text: `${this.t("askPay")}
_${this.t("payNote")}_`,
          buttons: modes.slice(0, 3).map((m) => ({ id: `pay:${m}`, title: this.t(`pay_${m}`) }))
        });
        return;
      }
    }
    return this.book();
  }
  async book() {
    const d = this.draft, cfg = this.deps.cfg;
    const idempotencyKey = `wa:${this.msg.id}`;
    const contact = { name: d.name, phone: this.phone, email: null, locale: this.locale };
    const token = await deriveStatusToken(this.deps.statusTokenSecret, cfg.operatorId, idempotencyKey);
    try {
      const r = await this.deps.store.createBooking({
        operatorId: cfg.operatorId,
        quoteId: d.quoteId,
        sessionHash: await sessionHash(`wa:${this.conv.waId}`),
        idempotencyKey,
        requestHash: await sha256Hex(canonicalJson({ quoteId: d.quoteId, contact, paymentMode: d.paymentMode, notes: null, flightExceptionReason: null })),
        contact,
        paymentMode: d.paymentMode,
        notes: null,
        statusTokenHash: await sha256Hex(token),
        actorId: null,
        flightExceptionReason: null,
        requestId: `wa-${this.msg.id}`
      });
      const url = this.statusUrl(r.reference, token);
      this.textOut(this.t("booked", { ref: r.reference, url }));
      this.bookingId = r.bookingId;
      this.draft = { name: d.name, lastRef: r.reference, lastUrl: url };
      this.step = "done";
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === "quote_expired") return this.quote(true);
      if (e.code === "pickup_too_soon") {
        delete d.time;
        this.clearQuote();
        this.textOut(this.t("tooSoon", { hours: Math.round(cfg.policy.config.lead_time_minutes / 60) }));
        return this.next();
      }
      if (e.code === "quote_already_used" && d.lastRef) {
        this.textOut(this.t("booked", { ref: d.lastRef, url: d.lastUrl ?? "" }));
        this.step = "done";
        return;
      }
      if (e.code === "quote_already_used" || e.code === "quote_not_found") {
        this.clearQuote();
        return this.next();
      }
      return this.handoff("staffOn");
    }
  }
  // ------------------------------------------------------------------------------- formatting
  vehicleLabel(code) {
    const v = this.deps.cfg.vehicleClasses.find((x) => x.code === code);
    return v ? this.locale === "en" ? v.labelEn : v.labelEs : code;
  }
  when(iso2) {
    const lc = this.locale === "en" ? "en-GB" : "es-AR";
    const tz = this.deps.cfg.timezone;
    const day = new Intl.DateTimeFormat(lc, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso2));
    const time = new Intl.DateTimeFormat(lc, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso2));
    return `${day} \xB7 ${time}`;
  }
  longDate(date) {
    const [y, m, dd] = date.split("-").map(Number);
    return new Intl.DateTimeFormat(this.locale === "en" ? "en-GB" : "es-AR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, dd, 12)));
  }
};
function looksLikeQuestion(text) {
  const t = text.trim().toLowerCase();
  if (/[?¿]/.test(t)) return true;
  return /^(como|cómo|cuanto|cuánto|cuanta|cuánta|cuantos|cuántos|donde|dónde|cuando|cuándo|puedo|pueden|aceptan|tienen|hay|incluye|es posible|se puede|how|what|where|when|can i|can you|do you|does|is it|is there|are there|will)\b/.test(t) && t.split(/\s+/).length >= 3;
}

// supabase/functions/_shared/whatsapp/notify.ts
var WINDOW_MS = 24 * 36e5 - 5 * 6e4;
async function composeNotification(kind, ctx, opts) {
  if (!ctx) return { send: false, reason: "booking_not_found", final: true };
  const app = opts.publicAppUrl.replace(/\/$/, "");
  const when2 = (iso2, lc) => {
    const l = lc === "en" ? "en-GB" : "es-AR";
    const d = new Date(iso2);
    return `${new Intl.DateTimeFormat(l, { timeZone: opts.timezone, weekday: "short", day: "numeric", month: "short" }).format(d)} \xB7 ${new Intl.DateTimeFormat(l, { timeZone: opts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
  };
  const time = (iso2) => new Intl.DateTimeFormat("es-AR", { timeZone: opts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso2));
  const route = (_lc) => {
    const place = ctx.zone ?? "";
    return ctx.direction === "from_airport" ? `\u{1F6EC} ${ctx.airport}${ctx.flight ? ` (${ctx.flight})` : ""} \u2192 ${place}` : `\u{1F6EB} ${place} \u2192 ${ctx.airport}`;
  };
  const inWindow = (last) => !!last && opts.now.getTime() - new Date(last).getTime() < WINDOW_MS;
  const digits = (p) => (p ?? "").replace(/\D/g, "");
  let to = null, lastInbound = null, locale = "es-AR";
  let message = null, params = [];
  switch (kind) {
    case "notify.passenger.booking_received":
      return { send: false, reason: ctx.source === "whatsapp" ? "sent_in_chat" : "not_whatsapp", final: true };
    case "notify.passenger.confirmed":
    case "notify.passenger.cancelled": {
      locale = ctx.passenger.locale === "en" ? "en" : "es-AR";
      to = digits(ctx.passenger.phone);
      lastInbound = ctx.passenger.lastInboundAt;
      if (kind.endsWith("confirmed")) {
        if (ctx.state !== "confirmed" || !ctx.driver) return { send: false, reason: "state_changed", final: true };
        const token = await deriveStatusToken(opts.statusTokenSecret, ctx.operatorId, ctx.idempotencyKey);
        const url = `${app}/reserva/${ctx.reference}?t=${token}`;
        message = { type: "text", text: say(locale, "nConfirmed", {
          ref: ctx.reference,
          route: route(locale),
          when: when2(ctx.pickupAt, locale),
          driver: ctx.driver.name.split(" ")[0],
          vehicle: ctx.driver.vehicle,
          plate: ctx.driver.plate,
          url
        }) };
        params = [ctx.reference, when2(ctx.pickupAt, locale), ctx.driver.name.split(" ")[0], `${ctx.driver.vehicle} ${ctx.driver.plate}`, url];
      } else {
        message = { type: "text", text: say(locale, "nCancelled", { ref: ctx.reference }) };
        params = [ctx.reference];
      }
      break;
    }
    case "notify.passenger.payment_due":
    case "notify.passenger.pickup_changed":
    case "notify.passenger.refund": {
      locale = ctx.passenger.locale === "en" ? "en" : "es-AR";
      to = digits(ctx.passenger.phone);
      lastInbound = ctx.passenger.lastInboundAt;
      const token = await deriveStatusToken(opts.statusTokenSecret, ctx.operatorId, ctx.idempotencyKey);
      const url = `${app}/reserva/${ctx.reference}?t=${token}`;
      if (kind.endsWith("payment_due")) {
        if (ctx.state !== "held") return { send: false, reason: "state_changed", final: true };
        const price = ctx.amountMinor !== null && ctx.currency ? formatMoney(ctx.amountMinor, ctx.currency, locale) : "";
        message = { type: "text", text: say(locale, "nPayDue", { ref: ctx.reference, route: route(locale), when: when2(ctx.pickupAt, locale), price, url }) };
        params = [ctx.reference, when2(ctx.pickupAt, locale), price, url];
      } else if (kind.endsWith("pickup_changed")) {
        if (ctx.state === "cancelled" || ctx.state === "closed") return { send: false, reason: "state_changed", final: true };
        message = { type: "text", text: say(locale, "nPickupChanged", { ref: ctx.reference, when: when2(ctx.pickupAt, locale), url }) };
        params = [ctx.reference, when2(ctx.pickupAt, locale), url];
      } else {
        message = { type: "text", text: say(locale, "nRefund", { ref: ctx.reference }) };
        params = [ctx.reference];
      }
      break;
    }
    case "notify.passenger.reminder":
    case "notify.passenger.rating": {
      locale = ctx.passenger.locale === "en" ? "en" : "es-AR";
      to = digits(ctx.passenger.phone);
      lastInbound = ctx.passenger.lastInboundAt;
      if (kind.endsWith("reminder")) {
        if (ctx.state !== "confirmed") return { send: false, reason: "state_changed", final: true };
        const token = await deriveStatusToken(opts.statusTokenSecret, ctx.operatorId, ctx.idempotencyKey);
        const url = `${app}/reserva/${ctx.reference}?t=${token}`;
        const driver = ctx.driver ? say(locale, "nReminderDriver", { driver: ctx.driver.name.split(" ")[0], vehicle: ctx.driver.vehicle, plate: ctx.driver.plate }) : "";
        message = { type: "text", text: say(locale, "nReminder", { ref: ctx.reference, route: route(locale), when: when2(ctx.pickupAt, locale), driver, url }) };
        params = [ctx.reference, when2(ctx.pickupAt, locale), url];
      } else {
        if (ctx.state !== "closed") return { send: false, reason: "state_changed", final: true };
        message = {
          type: "list",
          text: say(locale, "nRating", { ref: ctx.reference }),
          button: say(locale, "rateButton"),
          rows: [5, 4, 3, 2, 1].map((n) => ({ id: `rate:${ctx.bookingId}:${n}`, title: say(locale, `rate_${n}`) }))
        };
        params = [ctx.reference];
      }
      break;
    }
    case "notify.driver.pickup_changed": {
      const d = ctx.driver;
      if (!d) return { send: false, reason: "no_driver", final: true };
      if (!d.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(d.phone);
      lastInbound = d.lastInboundAt;
      message = { type: "text", text: say(locale, "nDriverPickupChanged", { ref: ctx.reference, when: when2(ctx.pickupAt, locale), flight: ctx.flight ?? "" }) };
      params = [ctx.reference, when2(ctx.pickupAt, locale)];
      break;
    }
    case "notify.driver.offer": {
      const o = ctx.offer;
      if (!o) return { send: false, reason: "offer_not_found", final: true };
      if (o.status !== "open" || new Date(o.expiresAt) <= opts.now) return { send: false, reason: "offer_closed", final: true };
      if (!o.driver.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(o.driver.phone);
      lastInbound = o.driver.lastInboundAt;
      const earn = o.earningsMinor !== null && o.currency ? formatMoney(o.earningsMinor, o.currency, locale) : "\u2014";
      message = {
        type: "buttons",
        text: say(locale, "nOffer", {
          ref: ctx.reference,
          route: route(locale),
          when: when2(ctx.pickupAt, locale),
          pax: ctx.passengers,
          bags: ctx.largeBags,
          earn,
          expires: time(o.expiresAt)
        }),
        buttons: [{ id: `offer:${o.id}:a`, title: say(locale, "btnAccept") }, { id: `offer:${o.id}:d`, title: say(locale, "btnDecline") }]
      };
      params = [ctx.reference, when2(ctx.pickupAt, locale), earn];
      break;
    }
    case "notify.driver.assigned":
    case "notify.driver.released": {
      const d = ctx.driver;
      if (!d) return { send: false, reason: "no_driver", final: true };
      if (!d.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(d.phone);
      lastInbound = d.lastInboundAt;
      message = { type: "text", text: kind.endsWith("assigned") ? say(locale, "nAssigned", { ref: ctx.reference, route: route(locale), when: when2(ctx.pickupAt, locale), url: `${app}/chofer` }) : say(locale, "nReleased", { ref: ctx.reference }) };
      params = [ctx.reference, when2(ctx.pickupAt, locale)];
      break;
    }
    default:
      return { send: false, reason: "unknown_kind", final: true };
  }
  if (!to || to.length < 6) return { send: false, reason: "no_phone", final: true };
  if (inWindow(lastInbound)) return { send: true, to, message, conversationPhone: `+${to}` };
  const tpl = opts.templates[kind];
  if (!tpl) return { send: false, reason: "no_template", final: true };
  const m = {
    type: "template",
    name: tpl.name,
    language: tpl.language,
    params,
    ...kind === "notify.driver.offer" && ctx.offer ? { buttonPayloads: [`offer:${ctx.offer.id}:a`, `offer:${ctx.offer.id}:d`] } : {}
  };
  return { send: true, to, message: m, conversationPhone: `+${to}` };
}

// supabase/functions/_shared/whatsapp/service.ts
var kindOf = (m) => m.type === "buttons" || m.type === "list" ? "interactive" : m.type;
async function sendAndRecord(deps2, conversationId, to, m, sentBy = null) {
  const id = await deps2.db.recordMessage(conversationId, "out", null, kindOf(m), m, previewOf(m), "queued", sentBy);
  const r = await deps2.sender.send(to, m);
  if (id) await deps2.db.markSent(id, r.id ?? null, r.error ? "failed" : "sent", r.error ?? null);
  return r;
}
async function processWebhook(parsed, deps2) {
  const log2 = deps2.log ?? (() => {
  });
  for (const s of parsed.statuses) await applyStatus(deps2, s);
  if (parsed.calls.length) {
    const cfg2 = await deps2.config();
    for (const c of parsed.calls) {
      try {
        if (c.event === "connect" && c.from && c.sdp) {
          if (!await routeToBot(deps2, cfg2.operatorId, c.id, c.from, c.profileName ?? null, c.sdp, log2)) {
            await deps2.db.callIncoming(cfg2.operatorId, c.id, c.from, c.profileName ?? null, c.sdp);
          }
        } else if (c.event === "terminate") {
          const known = deps2.voiceBot ? await deps2.db.callByProvider(c.id) : null;
          if (known?.handledBy === "bot") await deps2.voiceBot.disconnect(c.id).catch(() => {
          });
          await deps2.db.callTerminated(c.id, c.status ?? "COMPLETED", c.duration ?? null, c.error ?? null);
        }
      } catch (e) {
        log2({ level: "error", where: "wa-call", call: c.id, error: String(e?.message ?? e).slice(0, 300) });
      }
    }
  }
  let handled = 0, skipped = 0;
  const cfg = parsed.messages.length ? await deps2.config() : null;
  for (const msg of parsed.messages) {
    if (!await deps2.db.inboxClaim(cfg.operatorId, `msg:${msg.id}`)) {
      skipped++;
      continue;
    }
    try {
      await handleOne(msg, cfg, deps2);
      handled++;
    } catch (e) {
      log2({ level: "error", where: "wa-webhook", msg: msg.id, error: String(e?.message ?? e).slice(0, 300) });
    } finally {
      await deps2.db.inboxDone(`msg:${msg.id}`);
    }
  }
  return { handled, skipped };
}
async function applyStatus(deps2, s) {
  await deps2.db.statusUpdate(s.id, s.status, s.error ?? null);
}
async function handleOne(msg, cfg, deps2) {
  const now = deps2.now?.() ?? /* @__PURE__ */ new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await deps2.db.openConversation(cfg.operatorId, msg.from, msg.profileName ?? null);
    if (attempt === 0) {
      await deps2.db.recordMessage(row.id, "in", msg.id, msg.rawType, sanitize(msg), inboundPreview(msg), "received");
    }
    if (row.handoff_owner) return;
    const conv = {
      id: row.id,
      operatorId: row.operator_id,
      waId: row.wa_id,
      profileName: row.profile_name,
      kind: row.kind,
      driverId: row.driver_id,
      locale: row.locale,
      step: row.step ?? "menu",
      draft: row.draft ?? {}
    };
    const r = await handleMessage(conv, msg, {
      cfg,
      now,
      store: deps2.store,
      ai: deps2.ai ?? null,
      statusTokenSecret: deps2.statusTokenSecret,
      publicAppUrl: deps2.publicAppUrl,
      bookingsForPhone: (phone) => deps2.db.bookingsForPhone(cfg.operatorId, phone),
      driverRespond: (d, o, a) => deps2.db.driverRespond(d, o, a),
      cancelBooking: deps2.db.passengerCancel ? (phone, ref, ok) => deps2.db.passengerCancel(cfg.operatorId, phone, ref, ok, "whatsapp") : void 0,
      rate: deps2.db.rate ? (phone, id, n, c) => deps2.db.rate(cfg.operatorId, phone, id, n, c) : void 0,
      assistant: deps2.assistant ?? null,
      customerContext: deps2.db.customerContext ? (phone) => deps2.db.customerContext(cfg.operatorId, phone) : void 0
    });
    const saved = await deps2.db.saveConversation(row.id, row.version, r.step, r.draft, r.locale, r.bookingId ?? null, r.needsStaff ? true : null);
    if (saved === null) continue;
    for (const m of r.replies) await sendAndRecord(deps2, row.id, row.wa_id, m);
    return;
  }
  throw new Error("conversation_busy");
}
function inboundPreview(m) {
  if (m.type === "text") return m.text ?? "";
  if (m.type === "reply") return `\u25B8 ${m.replyTitle ?? m.replyId}`;
  if (m.type === "location") return `\u{1F4CD} ${m.location?.name ?? ""} ${m.location?.address ?? ""} (${m.location?.lat.toFixed(5)}, ${m.location?.lng.toFixed(5)})`.trim();
  return `(${m.rawType})`;
}
function sanitize(m) {
  return { type: m.type, text: m.text, replyId: m.replyId, replyTitle: m.replyTitle, location: m.location, rawType: m.rawType };
}
async function processOutbox(deps2, limit = 20) {
  const cfg = await deps2.config();
  const now = deps2.now?.() ?? /* @__PURE__ */ new Date();
  const jobs = await deps2.db.outboxClaim(limit);
  let sent = 0, skipped = 0, failed = 0;
  for (const job of jobs) {
    try {
      const ctx = await deps2.db.notificationContext(job.kind, job.payload);
      const c = await composeNotification(job.kind, ctx, {
        now,
        timezone: cfg.timezone,
        publicAppUrl: deps2.publicAppUrl,
        statusTokenSecret: deps2.statusTokenSecret,
        templates: deps2.templates ?? {}
      });
      if (!c.send) {
        await deps2.db.outboxFinish(job.id, true, c.reason, false);
        skipped++;
        continue;
      }
      const conv = await deps2.db.openConversationForNotify(cfg.operatorId, c.to);
      const r = conv ? await sendAndRecord(deps2, conv, c.to, c.message) : await deps2.sender.send(c.to, c.message);
      if (r.error) {
        const permanent = /^4\d\d /.test(r.error) && !/^429 /.test(r.error);
        await deps2.db.outboxFinish(job.id, false, r.error, permanent);
        failed++;
      } else {
        await deps2.db.outboxFinish(job.id, true, null, false);
        sent++;
      }
    } catch (e) {
      await deps2.db.outboxFinish(job.id, false, String(e?.message ?? e).slice(0, 300), false);
      failed++;
    }
  }
  return { sent, skipped, failed };
}
async function callAction(deps2, userId, isStaffOf, input) {
  const api = deps2.calls;
  if (!api) return { status: 503, body: { error: { code: "whatsapp_not_configured" } } };
  const id = String(input.callId ?? "");
  const action = String(input.action ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id) || !["accept", "reject", "terminate"].includes(action)) return { status: 400, body: { error: { code: "invalid_request" } } };
  const call = await deps2.db.callGet(id);
  if (!call) return { status: 404, body: { error: { code: "call_not_found" } } };
  if (!await isStaffOf(call.operator_id)) return { status: 403, body: { error: { code: "forbidden" } } };
  if (action === "accept") {
    const sdp = String(input.sdp ?? "");
    if (!sdp.startsWith("v=0") || sdp.length > 2e4) return { status: 400, body: { error: { code: "invalid_sdp" } } };
    const claimed = await deps2.db.callClaim(id, userId);
    if (!claimed) return { status: 409, body: { error: { code: call.status === "ringing" ? "call_taken" : `call_${call.status}` } } };
    const pre = await api.action(call.provider_call_id, "pre_accept", sdp);
    const acc = pre.ok ? await api.action(call.provider_call_id, "accept", sdp) : pre;
    if (!acc.ok) {
      await deps2.db.callSet(id, "failed", acc.error ?? "accept_failed");
      return { status: 502, body: { error: { code: "accept_failed", message: acc.error } } };
    }
    await deps2.db.callSet(id, "active");
    return { status: 200, body: { status: "active" } };
  }
  if (action === "reject") {
    if (call.status !== "ringing") return { status: 409, body: { error: { code: `call_${call.status}` } } };
    const r2 = await api.action(call.provider_call_id, "reject");
    await deps2.db.callSet(id, "rejected", r2.ok ? null : r2.error);
    return { status: 200, body: { status: "rejected" } };
  }
  if (!["answering", "active"].includes(call.status)) return { status: 409, body: { error: { code: `call_${call.status}` } } };
  const r = await api.action(call.provider_call_id, "terminate");
  await deps2.db.callSet(id, "ended", r.ok ? null : r.error);
  return { status: 200, body: { status: "ended" } };
}
async function routeToBot(deps2, operatorId, callId, waId, name, sdp, log2) {
  if (!deps2.voiceBot || !deps2.voiceSecret || !deps2.voiceToolUrl) return false;
  const route = await deps2.db.callRoute(operatorId);
  if (route.mode !== "bot") return false;
  const room = `stt-call-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const phone = `+${waId.replace(/\D/g, "")}`;
  try {
    await deps2.voiceBot.accept({ callId, sdp, room, callerPhone: phone, attributes: {
      bcu_assistant: VOICE_ASSISTANT,
      caller_phone: phone,
      caller_name: name ?? "",
      wa_call_id: callId,
      stt_token: await voiceToken(deps2.voiceSecret, callId),
      stt_api: deps2.voiceToolUrl,
      stt_voice: route.voiceId ?? ""
    } });
    await deps2.db.callBotStarted(operatorId, callId, waId, name, room);
    return true;
  } catch (e) {
    log2({ level: "error", where: "wa-voice-bot", call: callId, error: String(e?.message ?? e).slice(0, 300) });
    return false;
  }
}

// supabase/functions/whatsapp/index.ts
function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const first = Object.values(JSON.parse(keys))[0];
    if (first) return first;
  }
  throw new Error("missing service role / secret key");
}
var env = (k) => Deno.env.get(k) ?? "";
var SUPABASE_URL = env("SUPABASE_URL");
var KEY = serviceKey();
var db = createClient2(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
var store = new SupabaseStore(SUPABASE_URL, KEY);
var SLUG = env("OPERATOR_SLUG") || "soytutaxi";
var PUBLIC_APP_URL = env("PUBLIC_APP_URL") || "https://bcuproject.github.io/soytutaxi";
var STATUS_SECRET = env("STATUS_TOKEN_SECRET") || `status:${KEY}`;
var CORS = {
  "access-control-allow-origin": env("ALLOWED_ORIGINS") || "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS"
};
var json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
var log = (o) => console.log(JSON.stringify({ fn: "whatsapp", ...o }));
var envTemplates = {};
try {
  envTemplates = JSON.parse(env("WHATSAPP_TEMPLATES") || "{}");
} catch {
  log({ level: "warn", msg: "WHATSAPP_TEMPLATES is not valid JSON" });
}
var SEC = secretSource(db, env);
var sec = (k) => SEC.get(k);
var RT = {
  phoneId: env("WHATSAPP_PHONE_NUMBER_ID"),
  wabaId: env("WHATSAPP_WABA_ID"),
  templates: envTemplates,
  at: 0
};
async function refreshRuntime(force = false) {
  if (!force && Date.now() - RT.at < 3e4) return;
  RT.at = Date.now();
  try {
    const { data } = await db.rpc("wa_runtime_get");
    RT.phoneId = env("WHATSAPP_PHONE_NUMBER_ID") || data?.phoneNumberId || "";
    RT.wabaId = env("WHATSAPP_WABA_ID") || data?.wabaId || "";
    RT.templates = { ...data?.templates ?? {}, ...envTemplates };
  } catch {
  }
}
async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    if (error.message && /^[a-z_]+$/.test(error.message)) throw new ApiError(Number(error.details) || 400, error.message, error.hint ?? error.message);
    throw new Error(`${fn}: ${error.message}`);
  }
  return data;
}
var waDb = {
  openConversation: (op, wa, name) => rpc("wa_open_conversation", { p_operator: op, p_wa_id: wa, p_profile_name: name }),
  saveConversation: (id, v, step, draft, locale, lastBooking, needsStaff) => rpc("wa_save_conversation", { p_id: id, p_expected_version: v, p_step: step, p_draft: draft, p_locale: locale, p_last_booking: lastBooking, p_needs_staff: needsStaff }),
  recordMessage: (c, dir, pid, kind, body, preview, status, sentBy = null) => rpc("wa_record_message", { p_conversation: c, p_direction: dir, p_provider_id: pid, p_kind: kind, p_body: body, p_preview: preview, p_status: status, p_sent_by: sentBy }),
  markSent: (id, pid, status, error = null) => rpc("wa_mark_sent", { p_message: id, p_provider_id: pid, p_status: status, p_error: error }),
  statusUpdate: (pid, status, error = null) => rpc("wa_status_update", { p_provider_id: pid, p_status: status, p_error: error }),
  inboxClaim: (op, key) => rpc("wa_inbox_claim", { p_operator: op, p_event_key: key }),
  inboxDone: (key) => rpc("wa_inbox_done", { p_event_key: key }),
  bookingsForPhone: (op, phone) => rpc("wa_bookings_for_phone", { p_operator: op, p_phone: phone }),
  driverRespond: (d, o, a) => rpc("wa_driver_respond", { p_driver: d, p_offer: o, p_accept: a }),
  customerContext: (op, phone) => rpc("wa_customer_context", { p_operator: op, p_phone: phone }),
  callTranscript: (id, t) => rpc("wa_call_transcript", { p_call_id: id, p_transcript: t }),
  callTransferRequest: (id, reason) => rpc("wa_call_transfer_request", { p_call_id: id, p_reason: reason }),
  callTransferFailed: (id) => rpc("wa_call_transfer_failed", { p_call_id: id }),
  async callTransferClaim(id, user) {
    const r = await rpc("wa_call_transfer_claim", { p_call: id, p_user: user });
    return r?.id ? r : null;
  },
  passengerCancel: (op, phone, ref, ok, via) => rpc("wa_passenger_cancel", { p_operator: op, p_phone: phone, p_reference: ref, p_confirm: ok, p_via: via }),
  rate: (op, phone, id, n, c) => rpc("wa_rate", { p_operator: op, p_phone: phone, p_booking: id, p_score: n, p_comment: c }),
  outboxClaim: (limit) => rpc("wa_outbox_claim", { p_limit: limit }),
  outboxFinish: (job, ok, error, final) => rpc("wa_outbox_finish", { p_job: job, p_ok: ok, p_error: error, p_final: final }),
  notificationContext: (kind, payload) => rpc("wa_notification_context", { p_kind: kind, p_payload: payload }),
  openConversationForNotify: (op, wa) => rpc("wa_open_conversation_for_notify", { p_operator: op, p_wa_id: wa }),
  callIncoming: (op, id, wa, name, sdp) => rpc("wa_call_incoming", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_sdp: sdp }),
  callTerminated: (id, status, duration, error) => rpc("wa_call_terminated", { p_call_id: id, p_status: status, p_duration: duration, p_error: error }),
  async callGet(id) {
    const { data, error } = await db.from("wa_calls").select("id, operator_id, provider_call_id, status, answered_by").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  },
  async callClaim(id, user) {
    const r = await rpc("wa_call_claim", { p_call: id, p_user: user });
    return r?.id ? r : null;
  },
  callSet: async (id, status, error = null) => {
    await rpc("wa_call_set", { p_call: id, p_status: status, p_error: error });
  },
  callRoute: (op) => rpc("wa_call_route", { p_operator: op }),
  callBotStarted: (op, id, wa, name, room) => rpc("wa_call_bot_started", { p_operator: op, p_call_id: id, p_wa_id: wa, p_name: name, p_room: room }),
  async callByProvider(id) {
    const { data, error } = await db.from("wa_calls").select("*").eq("provider_call_id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? {
      operatorId: data.operator_id,
      providerCallId: data.provider_call_id,
      phone: data.phone_e164,
      waId: data.wa_id,
      name: data.caller_name,
      status: data.status,
      handledBy: data.handled_by,
      endedAt: data.ended_at,
      conversationId: data.conversation_id
    } : null;
  },
  callNote: async (id, note, callback) => {
    await rpc("wa_call_bot_note", { p_call_id: id, p_note: note, p_callback: callback });
  }
};
var DESK_ROLES = ["admin", "dispatcher", "agent"];
async function staffOf(userId, operatorId) {
  const { data } = await db.from("memberships").select("role").eq("operator_id", operatorId).eq("user_id", userId).eq("active", true);
  return (data ?? []).some((r) => DESK_ROLES.includes(r.role));
}
async function staffUser(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return null;
  const { data: u } = await db.auth.getUser(bearer);
  return u?.user ?? null;
}
var configured = () => !!(sec("WHATSAPP_ACCESS_TOKEN") && RT.phoneId);
var sender = { send: (to, m) => graphSender(RT.phoneId, sec("WHATSAPP_ACCESS_TOKEN")).send(to, m) };
var AI = { key: "", ai: null, assistant: null };
function aiNow() {
  const key = sec("AI_API_KEY");
  if (key !== AI.key) {
    const c = { apiKey: key, baseUrl: sec("AI_BASE_URL") || void 0, model: sec("AI_MODEL") || void 0 };
    Object.assign(AI, { key, ai: key ? makeExtractor(c) : null, assistant: key ? makeAssistant(c) : null });
  }
  return AI;
}
var deps = {
  db: waDb,
  store,
  sender,
  log,
  statusTokenSecret: STATUS_SECRET,
  publicAppUrl: PUBLIC_APP_URL,
  get templates() {
    return RT.templates;
  },
  get ai() {
    return aiNow().ai;
  },
  get assistant() {
    return aiNow().assistant;
  },
  get calls() {
    return configured() ? graphCalls(RT.phoneId, sec("WHATSAPP_ACCESS_TOKEN")) : void 0;
  },
  get voiceBot() {
    return configured() && sec("LIVEKIT_URL") && sec("LIVEKIT_API_KEY") && sec("LIVEKIT_API_SECRET") ? liveKitVoiceBot({
      url: sec("LIVEKIT_URL"),
      apiKey: sec("LIVEKIT_API_KEY"),
      apiSecret: sec("LIVEKIT_API_SECRET"),
      phoneNumberId: RT.phoneId,
      waToken: sec("WHATSAPP_ACCESS_TOKEN")
    }) : void 0;
  },
  voiceSecret: env("VOICE_TOKEN_SECRET") || `voice:${KEY}`,
  voiceToolUrl: `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/whatsapp/voice-tool`,
  async config() {
    const c = await store.loadConfig(SLUG);
    if (!c) throw new Error("operator_not_configured");
    return c;
  }
};
var background = (p) => globalThis.EdgeRuntime?.waitUntil ? globalThis.EdgeRuntime.waitUntil(p) : p;
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  await Promise.all([refreshRuntime(), SEC.refresh()]);
  if (req.method === "GET") {
    const token = sec("WHATSAPP_VERIFY_TOKEN");
    if (url.searchParams.get("hub.mode") === "subscribe" && token && url.searchParams.get("hub.verify_token") === token) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed" } });
  if (path.endsWith("/outbox")) {
    const ok = await rpc("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" }).catch(() => false);
    if (!ok) return json(401, { error: { code: "unauthenticated" } });
    if (!configured()) return json(503, { error: { code: "whatsapp_not_configured" } });
    const r = await processOutbox(deps);
    if (r.sent || r.failed) log({ level: "info", outbox: r });
    return json(200, r);
  }
  if (path.endsWith("/voice-tool")) {
    const body = await req.json().catch(() => ({}));
    const cfg = await deps.config();
    const r = await voiceTool({
      cfg,
      store,
      now: /* @__PURE__ */ new Date(),
      secret: deps.voiceSecret,
      statusTokenSecret: STATUS_SECRET,
      publicAppUrl: PUBLIC_APP_URL,
      call: (id) => waDb.callByProvider(id),
      bookingsForPhone: (phone) => waDb.bookingsForPhone(cfg.operatorId, phone),
      note: (id, note, cb) => waDb.callNote(id, note, cb),
      cancel: (phone, ref, ok) => waDb.passengerCancel(cfg.operatorId, phone, ref, ok, "voice"),
      transfer: (id, reason) => waDb.callTransferRequest(id, reason),
      transferFailed: (id) => waDb.callTransferFailed(id),
      customerContext: (phone) => waDb.customerContext(cfg.operatorId, phone),
      saveTranscript: (id, t) => waDb.callTranscript(id, t),
      async sendWhatsApp(call, m) {
        if (!configured() || !call.conversationId) return false;
        const sent = await sendAndRecord(deps, call.conversationId, call.waId, m);
        return !sent.error;
      }
    }, body ?? {});
    if (r.status >= 400) log({ level: "warn", voiceTool: r.status, action: body?.action });
    return json(r.status, r.body);
  }
  if (path.endsWith("/call-action")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const body = await req.json().catch(() => ({}));
    const r = await callAction(deps, user.id, (op) => staffOf(user.id, op), body ?? {});
    return json(r.status, r.body);
  }
  if (path.endsWith("/bootstrap-admin")) {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const code = String(body?.code ?? "").trim().toUpperCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(422, { error: { code: "invalid_email" } });
    if (password.length < 10) return json(422, { error: { code: "weak_password" } });
    const hash = await sha256Hex(`setup:${code}`);
    if (!await rpc("setup_code_valid", { p_code_hash: hash }).catch(() => false)) return json(403, { error: { code: "invalid_code" } });
    const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error && !/already|registered|exists/i.test(error.message)) return json(400, { error: { code: "create_failed", message: error.message } });
    if (!await rpc("setup_code_redeem", { p_code_hash: hash, p_email: email }).catch(() => false)) return json(403, { error: { code: "invalid_code" } });
    await rpc("setup_grant_admin", { p_email: email });
    log({ level: "info", msg: "admin created from /conexion", existing: !!error });
    return json(200, { ok: true, existing: !!error });
  }
  if (path.endsWith("/setup")) {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    let userId = null;
    const user = await staffUser(req);
    if (user) {
      const { data } = await db.from("memberships").select("role").eq("user_id", user.id).eq("active", true).eq("role", "admin");
      if (!data?.length) return json(403, { error: { code: "forbidden" } });
      userId = user.id;
    } else {
      const keyOk = await rpc("wa_outbox_key_ok", { p_key: req.headers.get("x-outbox-key") ?? "" }).catch(() => false);
      if (!keyOk) return json(401, { error: { code: "unauthenticated" } });
      if (!["status", "use_number", "webhook", "calling", "templates", "test_send"].includes(action)) return json(403, { error: { code: "admin_required" } });
    }
    await Promise.all([refreshRuntime(true), SEC.refresh(true)]);
    if (action === "webhook" && !sec("WHATSAPP_VERIFY_TOKEN")) {
      await rpc("secrets_ensure_verify_token", {}).catch(() => false);
      await SEC.refresh(true);
    }
    const r = await runSetup(action, body?.args ?? {}, {
      token: sec("WHATSAPP_ACCESS_TOKEN"),
      callbackUrl: `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/whatsapp`,
      verifyToken: sec("WHATSAPP_VERIFY_TOKEN"),
      wabaId: RT.wabaId,
      phoneNumberId: RT.phoneId,
      appSecret: sec("WHATSAPP_APP_SECRET")
    }, graph(sec("WHATSAPP_ACCESS_TOKEN")));
    if (r.save) {
      await rpc("wa_runtime_set", {
        p_phone: r.save.phoneNumberId ?? null,
        p_waba: r.save.wabaId ?? null,
        p_templates: r.save.templates ?? null,
        p_user: userId
      });
      await refreshRuntime(true);
    }
    log({ level: r.ok ? "info" : "warn", setup: action, ok: r.ok, by: userId ? "admin" : "server" });
    return json(r.status, {
      ...r.body,
      secrets: {
        accessToken: !!sec("WHATSAPP_ACCESS_TOKEN"),
        appSecret: !!sec("WHATSAPP_APP_SECRET"),
        verifyToken: !!sec("WHATSAPP_VERIFY_TOKEN"),
        liveKit: !!(sec("LIVEKIT_URL") && sec("LIVEKIT_API_KEY") && sec("LIVEKIT_API_SECRET")),
        ai: !!sec("AI_API_KEY")
      },
      connected: { phoneNumberId: RT.phoneId || null, wabaId: RT.wabaId || null, templates: Object.keys(RT.templates).length }
    });
  }
  if (path.endsWith("/call-join")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const lk = { url: sec("LIVEKIT_URL"), apiKey: sec("LIVEKIT_API_KEY"), apiSecret: sec("LIVEKIT_API_SECRET") };
    if (!lk.url || !lk.apiKey || !lk.apiSecret) return json(503, { error: { code: "voice_not_configured" } });
    const body = await req.json().catch(() => ({}));
    const { data: row } = await db.from("wa_calls").select("operator_id").eq("id", String(body?.callId ?? "")).maybeSingle();
    if (!row) return json(404, { error: { code: "call_not_found" } });
    if (!await staffOf(user.id, row.operator_id)) return json(403, { error: { code: "forbidden" } });
    const c = await waDb.callTransferClaim(String(body.callId), user.id);
    if (!c || !c.bot_room) return json(409, { error: { code: "transfer_taken" } });
    const token = await mintLiveKitToken({
      apiKey: lk.apiKey,
      apiSecret: lk.apiSecret,
      identity: `desk-${user.id}`,
      name: `Central (${user.email?.split("@")[0] ?? "staff"})`,
      room: c.bot_room,
      canPublish: true,
      ttlSeconds: 3600,
      metadata: { kind: "desk" }
    });
    return json(200, { url: lk.url, token, room: c.bot_room });
  }
  if (path.endsWith("/staff-send")) {
    const user = await staffUser(req);
    if (!user) return json(401, { error: { code: "unauthenticated" } });
    const u = { user };
    const body = await req.json().catch(() => ({}));
    const text = String(body?.text ?? "").trim();
    if (!body?.conversationId || !text || text.length > 4e3) return json(400, { error: { code: "invalid_request" } });
    const { data: c } = await db.from("wa_conversations").select("id, operator_id, wa_id, last_inbound_at").eq("id", body.conversationId).maybeSingle();
    if (!c) return json(404, { error: { code: "conversation_not_found" } });
    if (!await staffOf(u.user.id, c.operator_id)) return json(403, { error: { code: "forbidden" } });
    if (!c.last_inbound_at || Date.now() - new Date(c.last_inbound_at).getTime() > 24 * 36e5) {
      return json(409, { error: { code: "window_closed", message: "M\xE1s de 24 h sin mensajes del cliente: WhatsApp s\xF3lo permite plantillas aprobadas." } });
    }
    if (!configured()) return json(503, { error: { code: "whatsapp_not_configured" } });
    const r = await sendAndRecord(deps, c.id, c.wa_id, { type: "text", text }, u.user.id);
    return r.error ? json(502, { error: { code: "send_failed", message: r.error } }) : json(200, { id: r.id });
  }
  const raw = await req.text();
  const secret = sec("WHATSAPP_APP_SECRET");
  if (!secret) return json(503, { error: { code: "whatsapp_not_configured" } });
  if (!await verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    log({ level: "warn", msg: "bad signature" });
    return json(401, { error: { code: "bad_signature" } });
  }
  let parsed;
  try {
    parsed = parseWebhook(JSON.parse(raw));
  } catch {
    return json(400, { error: { code: "bad_payload" } });
  }
  const expected = RT.phoneId;
  if (expected && parsed.phoneNumberId && parsed.phoneNumberId !== expected) return json(200, { ignored: "other_number" });
  background(processWebhook(parsed, deps).then((r) => r.handled && log({ level: "info", webhook: r })).catch((e) => log({ level: "error", msg: String(e?.message ?? e) })));
  return json(200, { ok: true });
});
