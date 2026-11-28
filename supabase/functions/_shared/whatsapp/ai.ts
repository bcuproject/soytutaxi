// Optional AI extraction of booking details from free text (OpenAI-compatible chat completions).
// Works with the Lovable AI gateway (as in BlackCabUnite), OpenAI, or Google's OpenAI-compatible
// endpoint. The AI only proposes fields; every value is re-validated by the deterministic parsers
// and fares/addresses/booking stay in backend commands.

import type { Locale } from "../domain/types.ts";

export interface AiFields {
  direction?: "from_airport" | "to_airport" | null;
  airport?: "EZE" | "AEP" | null;
  zone?: string | null;           // zone code from the provided list
  address?: string | null;        // street + number or hotel/building name, as written
  date?: string | null;           // YYYY-MM-DD
  time?: string | null;           // HH:mm 24h, local
  flight?: string | null;
  passengers?: number | null;
  large_bags?: number | null;
  carry_on?: number | null;
  language?: "es" | "en" | null;
  wants_staff?: boolean | null;
}

export interface Extractor {
  extract(text: string, ctx: { today: string; weekday: string; locale: Locale; zones: { code: string; name: string }[]; awaiting: string }): Promise<AiFields | null>;
}

export interface AiConfig {
  apiKey: string;
  baseUrl?: string;   // default: Lovable AI gateway
  model?: string;     // default: google/gemini-3-flash-preview (as BlackCabUnite)
  timeoutMs?: number;
}

export const LOVABLE_GATEWAY = "https://ai.gateway.lovable.dev/v1";

export function makeExtractor(cfg: AiConfig, fetchImpl: typeof fetch = fetch): Extractor {
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
        "Use null for anything not stated. Never guess or invent values. Resolve relative dates (mañana, tomorrow, el viernes) against today. For arrivals, time is the flight's scheduled landing time.",
        "address is the street and number or hotel/building name exactly as written (not the zone).",
      ].join("\n");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 4500);
      try {
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: lovable
            ? { "Lovable-API-Key": cfg.apiKey, "X-Lovable-AIG-SDK": "custom", "Content-Type": "application/json" }
            : { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: text.slice(0, 800) }],
          }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const raw = String(j?.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?|```$/g, "").trim();
        const obj = JSON.parse(raw);
        return obj && typeof obj === "object" ? (obj as AiFields) : null;
      } catch {
        return null;   // never block the chat on AI
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Assistant: answers free questions on WhatsApp (rides, bookings, policies) from the operator's facts and the
// customer's own memory (bookings, recent chat, previous calls). It never books, prices or cancels by itself:
// it returns an action and the engine runs the existing, validated flow for it.
// ---------------------------------------------------------------------------------------------------------
export type AssistantAction = "answer" | "book" | "bookings" | "cancel" | "staff";
export interface AssistantReply { action: AssistantAction; reply: string; reference?: string | null; language?: "es" | "en" | null }
export interface AssistantInput {
  text: string;
  locale: Locale;
  /** The booking question currently waiting for an answer (e.g. "passengers"), or "none". */
  awaiting: string;
  facts: unknown;
  customer: unknown;
}
export interface Assistant { reply(input: AssistantInput): Promise<AssistantReply | null> }

export function assistantPrompt(i: AssistantInput) {
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
- "staff": they want a person, want to CHANGE a booking (time, address, passengers…), complain, or need something you can't do.
${i.awaiting !== "none" ? `The customer is in the middle of a booking; the bot is waiting for: ${i.awaiting}. Just answer their question ("answer"); the bot will repeat its question.\n` : ""}
Return ONLY JSON: {"action": "...", "reply": "...", "reference": null, "language": "es"|"en"}

FACTS: ${JSON.stringify(i.facts)}
CUSTOMER: ${JSON.stringify(i.customer)}`;
}

export function makeAssistant(cfg: AiConfig, fetchImpl: typeof fetch = fetch): Assistant {
  const base = (cfg.baseUrl || LOVABLE_GATEWAY).replace(/\/$/, "");
  const lovable = base.includes("ai.gateway.lovable.dev");
  const model = cfg.model || (lovable ? "google/gemini-3-flash-preview" : "gpt-4o-mini");
  const ACTIONS: AssistantAction[] = ["answer", "book", "bookings", "cancel", "staff"];
  return {
    async reply(input) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 9000);
      try {
        const r = await fetchImpl(`${base}/chat/completions`, {
          method: "POST", signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model, temperature: 0.2, response_format: { type: "json_object" },
            messages: [{ role: "system", content: assistantPrompt(input) }, { role: "user", content: input.text.slice(0, 1000) }],
          }),
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
        return null;   // never block the chat on AI
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
