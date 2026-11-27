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
