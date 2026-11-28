import { OPERATOR_TZ } from "@shared/domain/time.ts";
import type { Locale } from "@shared/domain/types.ts";

export { formatMoney } from "@shared/domain/fare.ts";

let DEFAULT_LOCALE: Locale | string = "es-AR";
/** Language used when a caller doesn't pass one (the staff screens set it from their ES/EN switch). */
export function setDefaultLocale(l: Locale | string) { DEFAULT_LOCALE = l; }
const lc = (l: Locale | string) => (l === "en" ? "en-GB" : "es-AR");

export function fmtTime(iso: string, locale: Locale | string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(lc(locale), { timeZone: OPERATOR_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function fmtDateLong(iso: string, locale: Locale | string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(lc(locale), { timeZone: OPERATOR_TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso));
}

export function fmtDateShort(iso: string, locale: Locale | string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(lc(locale), { timeZone: OPERATOR_TZ, weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(iso));
}

export function fmtDateTime(iso: string, locale: Locale | string = DEFAULT_LOCALE): string {
  return `${fmtDateShort(iso, locale)} ${fmtTime(iso, locale)}`;
}

/** A local YYYY-MM-DD (as typed) rendered long, without timezone drift. */
export function fmtLocalDate(date: string, locale: Locale | string = DEFAULT_LOCALE): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(lc(locale), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}
