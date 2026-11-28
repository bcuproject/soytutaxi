// Deterministic Spanish/English parsers for booking details typed into WhatsApp.
// These run before (and validate) any AI extraction, so the chat works with or without AI.

import { FLIGHT_RE, normalizeFlight } from "../domain/quote.ts";
import { addDaysLocal, isValidLocalDate } from "../domain/time.ts";
import type { Direction, Locale, Zone } from "../domain/types.ts";

export interface Extracted {
  direction?: Direction;
  airport?: string;
  zoneCode?: string;
  placeText?: string;
  date?: string;
  dateOptions?: string[];      // ambiguous day/month → ask
  time?: string;
  flight?: string;
  passengers?: number;
  largeBags?: number;
  carryOn?: number;
  language?: Locale;
  wantsStaff?: boolean;
}

export const strip = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

const MONTHS: Record<string, number> = {
  ene: 1, enero: 1, jan: 1, january: 1, feb: 2, febrero: 2, february: 2, mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4, may: 5, mayo: 5, jun: 6, junio: 6, june: 6, jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8, sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10, nov: 11, noviembre: 11, november: 11, dic: 12, diciembre: 12, dec: 12, december: 12,
};

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Year for a day/month with no year: this year, or next year if that date already passed. */
function withYear(today: string, m: number, d: number): string | null {
  const y = Number(today.slice(0, 4));
  const a = iso(y, m, d);
  if (!isValidLocalDate(a)) return null;
  return a >= today ? a : (isValidLocalDate(iso(y + 1, m, d)) ? iso(y + 1, m, d) : null);
}

/** Parse a date. Returns { date } or { options } when day/month order is genuinely ambiguous. */
export function parseDate(text: string, today: string, locale: Locale): { date?: string; options?: string[] } | null {
  const t = strip(text);
  if (/\bpasado manana\b|\bday after tomorrow\b/.test(t)) return { date: addDaysLocal(today, 2) };
  if (/\bmanana\b|\btomorrow\b|\btmrw\b/.test(t)) return { date: addDaysLocal(today, 1) };
  if (/\bhoy\b|\btoday\b|\btonight\b|\besta noche\b/.test(t)) return { date: today };

  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) {
    const d = iso(+m[1], +m[2], +m[3]);
    return isValidLocalDate(d) ? { date: d } : null;
  }
  // 28 de noviembre / 28 nov / nov 28 / november 28th — scan every candidate, not just the first.
  for (const x of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:de\s+)?([a-z]{3,10})\b/g)) {
    if (MONTHS[x[2]]) { const d = withYear(today, MONTHS[x[2]], +x[1]); return d ? { date: d } : null; }
  }
  for (const x of t.matchAll(/\b([a-z]{3,10})\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    if (MONTHS[x[1]]) { const d = withYear(today, MONTHS[x[1]], +x[2]); return d ? { date: d } : null; }
  }

  // 28/11, 28/11/2026, 11-28 …
  m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (m) {
    const a = +m[1], b = +m[2];
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    const mk = (mo: number, d: number) => (year ? (isValidLocalDate(iso(year, mo, d)) ? iso(year, mo, d) : null) : withYear(today, mo, d));
    const dayFirst = mk(b, a), monthFirst = mk(a, b);
    if (locale === "en" && dayFirst && monthFirst && dayFirst !== monthFirst) return { options: [dayFirst, monthFirst] };
    const pick = locale === "en" ? monthFirst ?? dayFirst : dayFirst ?? monthFirst;
    return pick ? { date: pick } : null;
  }
  return null;
}

/** Parse a clock time: 14:30, 9.15, 10am, 10 pm, 22hs, 22 h, "a las 9". */
export function parseTime(text: string): string | null {
  const t = strip(text);
  let m = /\b([01]?\d|2[0-3])[:.h]([0-5]\d)\s*(am|pm|a\.?m\.?|p\.?m\.?)?\b/.exec(t);
  if (m) return fmt(+m[1], +m[2], m[3]);
  m = /\b(1[0-2]|0?[1-9])\s*(am|pm|a\.m\.|p\.m\.)\b/.exec(t);
  if (m) return fmt(+m[1], 0, m[2]);
  m = /\b([01]?\d|2[0-3])\s*(?:hs|hrs|h)\b/.exec(t);
  if (m) return fmt(+m[1], 0);
  m = /\ba las\s+([01]?\d|2[0-3])\b/.exec(t);
  if (m) return fmt(+m[1], 0);
  m = /^\s*([01]?\d|2[0-3])\s*$/.exec(t);
  if (m) return fmt(+m[1], 0);
  return null;
}

function fmt(h: number, min: number, ampm?: string): string | null {
  const ap = ampm?.replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Two-letter words that look like airline codes when followed by a number ("at 6", "a las 9").
const NOT_AIRLINES = new Set(["AT", "TO", "ON", "IN", "BY", "ME", "MY", "US", "WE", "AL", "EL", "DE", "EN", "UN", "SI", "NO", "OR", "AS", "IS", "IT", "OF", "UP", "SO", "AM", "PM", "HS", "YO", "MI", "SE", "LO", "TE", "ES", "ID"]);

export function parseFlight(text: string): string | null {
  const up = text.toUpperCase();
  // Joined form: AR1303, LA4521, G31234, AA997A
  for (const x of up.matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])([A-Z]?)(\d{1,4})([A-Z]?)\b/g)) {
    const f = normalizeFlight(x[0]);
    if (FLIGHT_RE.test(f) && !NOT_AIRLINES.has(x[1])) return f;
  }
  // Separated form: "AR 1303", "LA-4521" (needs ≥ 2 digits to avoid "at 6")
  for (const x of up.matchAll(/\b([A-Z][A-Z0-9]|[0-9][A-Z])[\s-](\d{2,4})([A-Z]?)\b/g)) {
    if (NOT_AIRLINES.has(x[1])) continue;
    const f = normalizeFlight(x[0]);
    if (FLIGHT_RE.test(f)) return f;
  }
  return null;
}

export function parseAirport(text: string): string | null {
  const t = strip(text);
  if (/\b(eze|ezeiza|ministro pistarini)\b/.test(t)) return "EZE";
  if (/\b(aep|aeroparque|jorge newbery|newbery)\b/.test(t)) return "AEP";
  return null;
}

export function parseDirection(text: string): Direction | null {
  const t = strip(text);
  // Arrival verbs decide first: "llego a Ezeiza" means FROM the airport even though it contains "a Ezeiza".
  if (/\b(llego|llegamos|llega|aterrizo|aterrizamos|aterriza|arrive|arriving|arrival|landing|land at|i land|we land)\b/.test(t)) return "from_airport";
  if (/\b(al aeropuerto|hacia el aeropuerto|a ezeiza|a aeroparque|para ezeiza|para aeroparque|to the airport|to eze|to aep|to ezeiza|to aeroparque|mi vuelo sale|my flight leaves|departure|departing|salgo|me voy)\b/.test(t)) return "to_airport";
  if (/\b(desde el aeropuerto|del aeropuerto|desde ezeiza|desde aeroparque|de ezeiza|de aeroparque|from the airport|from eze|from aep|from ezeiza|from aeroparque|llego|aterrizo|aterriza|arrive|arriving|arrival|landing|land at|pick me up at (the )?airport|recoger en)\b/.test(t)) return "from_airport";
  return null;
}

const ZONE_ALIASES: Record<string, string[]> = {
  palermo: ["palermo", "palermo soho", "palermo hollywood", "las canitas"],
  recoleta: ["recoleta", "barrio norte"],
  microcentro: ["microcentro", "retiro", "centro", "downtown", "san nicolas", "city centre", "city center", "obelisco"],
  puerto_madero: ["puerto madero"],
  belgrano: ["belgrano", "nunez", "colegiales"],
  tigre: ["tigre", "nordelta"],
};

export function parseZone(text: string, zones: Zone[]): string | null {
  const t = strip(text);
  const active = zones.filter((z) => z.active);
  // Longest alias first so "puerto madero" beats "madero" style collisions.
  const pairs = active.flatMap((z) => [...(ZONE_ALIASES[z.code] ?? []), strip(z.name)].map((a) => [a, z.code] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, code] of pairs) if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return code;
  return null;
}

export function parseCount(text: string, kind: "passengers" | "large" | "carry"): number | null {
  const t = strip(text);
  const words: Record<string, number> = { un: 1, una: 1, uno: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5, seis: 6, six: 6, siete: 7, seven: 7, ocho: 8, eight: 8, nueve: 9, nine: 9, diez: 10, ten: 10 };
  const num = "(\\d{1,2}|" + Object.keys(words).join("|") + ")";
  const nouns = kind === "passengers" ? "(?:pasajeros?|personas?|people|persons?|pax|adults?|adultos?|passengers?)"
    : kind === "large" ? "(?:valijas?|maletas?|suitcases?|bags?|luggage|equipajes? grandes?)"
    : "(?:(?:equipajes? |bolsos? )?de mano|carry[- ]?ons?|hand luggage|mochilas?|backpacks?)";
  let m = new RegExp(`\\b${num}\\s+${nouns}\\b`).exec(t);
  if (!m && kind === "passengers") m = new RegExp(`\\b(?:somos|seremos|vamos|viajamos|we are|we're|were|party of|group of)\\s+${num}\\b`).exec(t);
  if (!m) return null;
  const v = /^\d+$/.test(m[1]) ? +m[1] : words[m[1]];
  return v >= 0 && v <= 60 ? v : null;
}

export function detectLanguage(text: string): Locale | null {
  const t = strip(text);
  const en = (t.match(/\b(hi|hello|hey|please|airport|tomorrow|today|from|to the|flight|pick|need|want|book|taxi to|people|bags|thanks|thank you|english)\b/g) ?? []).length;
  const es = (t.match(/\b(hola|buen[oa]s|aeropuerto|manana|hoy|desde|hacia|vuelo|quiero|necesito|reservar|personas|valijas|gracias|por favor|espanol)\b/g) ?? []).length;
  if (en > es) return "en";
  if (es > en) return "es-AR";
  return null;
}

export const wantsStaff = (text: string) =>
  /\b(humano|persona real|hablar con (una )?persona|operador|operadora|agente|hablar con alguien|atencion humana|staff|human|agent|real person|a person|speak to someone|talk to someone)\b/.test(strip(text));
export const wantsMenu = (text: string) => /^(menu|menú|hola|hi|hello|hey|buenas|buen dia|buenos dias|buenas tardes|buenas noches|inicio|start|empezar)[!. ]*$/.test(strip(text));
export const wantsCancel = (text: string) => /^(cancelar|cancel|salir|exit|reset|empezar de nuevo|start over)[!. ]*$/.test(strip(text));
/** "quiero hacer una reserva", "reservar", "I need a taxi", "book a transfer"… (a new trip, not an existing one). */
export const wantsBooking = (text: string) => {
  const p = strip(text);
  if (/\b(mi reserva|mis reservas|my booking|cancel)/.test(p)) return false;
  return /\b(reserv\w*|book\w*|taxi|remis\w*|traslado\w*|transfer\w*|viaje|un auto|un coche|ride|cab)\b/.test(p);
};

export const wantsStatus = (text: string) => /\b(mi reserva|estado|status|my booking|check booking|consultar)\b/.test(strip(text));

/** Everything that can be read from one message without AI. */
export function extractAll(text: string, zones: Zone[], today: string, locale: Locale): Extracted {
  const e: Extracted = {};
  const dir = parseDirection(text); if (dir) e.direction = dir;
  const ap = parseAirport(text); if (ap) e.airport = ap;
  const z = parseZone(text, zones); if (z) e.zoneCode = z;
  const d = parseDate(text, today, locale);
  if (d?.date) e.date = d.date; else if (d?.options) e.dateOptions = d.options;
  // Only read a time if the message is clearly not a date-only answer like "28/11".
  const tm = parseTime(text.replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, " "));
  if (tm && !/^\s*\d{1,2}\s*$/.test(text)) e.time = tm;
  const f = parseFlight(text); if (f) e.flight = f;
  const p = parseCount(text, "passengers"); if (p !== null) e.passengers = p;
  const l = parseCount(text, "large"); if (l !== null) e.largeBags = l;
  const c = parseCount(text, "carry"); if (c !== null) e.carryOn = c;
  const lang = detectLanguage(text); if (lang) e.language = lang;
  if (wantsStaff(text)) e.wantsStaff = true;
  return e;
}
