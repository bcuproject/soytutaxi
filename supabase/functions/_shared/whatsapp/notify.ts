// Turns outbox jobs (notify.*) into WhatsApp messages. Inside Meta's 24 h service window a normal
// message is sent; outside it only an approved template may be sent (configured per job kind).

import { deriveStatusToken } from "../domain/crypto.ts";
import { formatMoney } from "../domain/fare.ts";
import type { Locale } from "../domain/types.ts";
import { say } from "./copy.ts";
import type { Outbound } from "./meta.ts";

export interface NotificationContext {
  bookingId: string; reference: string; state: string; source: string; direction: "from_airport" | "to_airport";
  airport: string; zone: string | null; pickupAt: string; flight: string | null; passengers: number; largeBags: number;
  amountMinor: number | null; currency: string | null; idempotencyKey: string; operatorId: string;
  passenger: { name: string; phone: string | null; locale: string | null; lastInboundAt: string | null };
  driver: { id: string; name: string; phone: string | null; verified: boolean; plate: string; vehicle: string; lastInboundAt: string | null } | null;
  offer: { id: string; status: string; expiresAt: string; earningsMinor: number | null; currency: string | null;
           driver: { id: string; name: string; phone: string | null; verified: boolean; lastInboundAt: string | null } } | null;
}

/** Template to use outside the 24 h window, keyed by job kind (e.g. "notify.passenger.confirmed"). */
export type TemplateMap = Record<string, { name: string; language: string }>;

export type Composed =
  | { send: true; to: string; message: Outbound; conversationPhone: string }
  | { send: false; reason: string; final: boolean };

const WINDOW_MS = 24 * 3600_000 - 5 * 60_000;   // keep a 5-minute safety margin

export async function composeNotification(
  kind: string, ctx: NotificationContext | null, opts: { now: Date; timezone: string; publicAppUrl: string; statusTokenSecret: string; templates: TemplateMap },
): Promise<Composed> {
  if (!ctx) return { send: false, reason: "booking_not_found", final: true };
  const app = opts.publicAppUrl.replace(/\/$/, "");
  const when = (iso: string, lc: Locale) => {
    const l = lc === "en" ? "en-GB" : "es-AR";
    const d = new Date(iso);
    return `${new Intl.DateTimeFormat(l, { timeZone: opts.timezone, weekday: "short", day: "numeric", month: "short" }).format(d)} · ${
      new Intl.DateTimeFormat(l, { timeZone: opts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)}`;
  };
  const time = (iso: string) => new Intl.DateTimeFormat("es-AR", { timeZone: opts.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const route = (_lc: Locale) => {
    const place = ctx.zone ?? "";
    return ctx.direction === "from_airport" ? `🛬 ${ctx.airport}${ctx.flight ? ` (${ctx.flight})` : ""} → ${place}` : `🛫 ${place} → ${ctx.airport}`;
  };
  const inWindow = (last: string | null) => !!last && opts.now.getTime() - new Date(last).getTime() < WINDOW_MS;
  const digits = (p: string | null) => (p ?? "").replace(/\D/g, "");

  // Decide recipient + free-form message + template params for each kind.
  let to: string | null = null, lastInbound: string | null = null, locale: Locale = "es-AR";
  let message: Outbound | null = null, params: string[] = [];

  switch (kind) {
    case "notify.passenger.booking_received":
      // WhatsApp bookings already got the reference in the chat; web bookings get e-mail/web status.
      return { send: false, reason: ctx.source === "whatsapp" ? "sent_in_chat" : "not_whatsapp", final: true };
    case "notify.passenger.confirmed":
    case "notify.passenger.cancelled": {
      locale = ctx.passenger.locale === "en" ? "en" : "es-AR";
      to = digits(ctx.passenger.phone); lastInbound = ctx.passenger.lastInboundAt;
      if (kind.endsWith("confirmed")) {
        if (ctx.state !== "confirmed" || !ctx.driver) return { send: false, reason: "state_changed", final: true };
        const token = await deriveStatusToken(opts.statusTokenSecret, ctx.operatorId, ctx.idempotencyKey);
        const url = `${app}/reserva/${ctx.reference}?t=${token}`;
        message = { type: "text", text: say(locale, "nConfirmed", { ref: ctx.reference, route: route(locale), when: when(ctx.pickupAt, locale),
          driver: ctx.driver.name.split(" ")[0], vehicle: ctx.driver.vehicle, plate: ctx.driver.plate, url }) };
        params = [ctx.reference, when(ctx.pickupAt, locale), ctx.driver.name.split(" ")[0], `${ctx.driver.vehicle} ${ctx.driver.plate}`, url];
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
      to = digits(ctx.passenger.phone); lastInbound = ctx.passenger.lastInboundAt;
      const token = await deriveStatusToken(opts.statusTokenSecret, ctx.operatorId, ctx.idempotencyKey);
      const url = `${app}/reserva/${ctx.reference}?t=${token}`;
      if (kind.endsWith("payment_due")) {
        if (ctx.state !== "held") return { send: false, reason: "state_changed", final: true };
        const price = ctx.amountMinor !== null && ctx.currency ? formatMoney(ctx.amountMinor, ctx.currency, locale) : "";
        message = { type: "text", text: say(locale, "nPayDue", { ref: ctx.reference, route: route(locale), when: when(ctx.pickupAt, locale), price, url }) };
        params = [ctx.reference, when(ctx.pickupAt, locale), price, url];
      } else if (kind.endsWith("pickup_changed")) {
        if (ctx.state === "cancelled" || ctx.state === "closed") return { send: false, reason: "state_changed", final: true };
        message = { type: "text", text: say(locale, "nPickupChanged", { ref: ctx.reference, when: when(ctx.pickupAt, locale), url }) };
        params = [ctx.reference, when(ctx.pickupAt, locale), url];
      } else {
        message = { type: "text", text: say(locale, "nRefund", { ref: ctx.reference }) };
        params = [ctx.reference];
      }
      break;
    }
    case "notify.driver.pickup_changed": {
      const d = ctx.driver;
      if (!d) return { send: false, reason: "no_driver", final: true };
      if (!d.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(d.phone); lastInbound = d.lastInboundAt;
      message = { type: "text", text: say(locale, "nDriverPickupChanged", { ref: ctx.reference, when: when(ctx.pickupAt, locale), flight: ctx.flight ?? "" }) };
      params = [ctx.reference, when(ctx.pickupAt, locale)];
      break;
    }
    case "notify.driver.offer": {
      const o = ctx.offer;
      if (!o) return { send: false, reason: "offer_not_found", final: true };
      if (o.status !== "open" || new Date(o.expiresAt) <= opts.now) return { send: false, reason: "offer_closed", final: true };
      if (!o.driver.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(o.driver.phone); lastInbound = o.driver.lastInboundAt;
      const earn = o.earningsMinor !== null && o.currency ? formatMoney(o.earningsMinor, o.currency, locale) : "—";
      message = { type: "buttons", text: say(locale, "nOffer", { ref: ctx.reference, route: route(locale), when: when(ctx.pickupAt, locale),
          pax: ctx.passengers, bags: ctx.largeBags, earn, expires: time(o.expiresAt) }),
        buttons: [{ id: `offer:${o.id}:a`, title: say(locale, "btnAccept") }, { id: `offer:${o.id}:d`, title: say(locale, "btnDecline") }] };
      params = [ctx.reference, when(ctx.pickupAt, locale), earn];
      break;
    }
    case "notify.driver.assigned":
    case "notify.driver.released": {
      const d = ctx.driver;
      if (!d) return { send: false, reason: "no_driver", final: true };
      if (!d.verified) return { send: false, reason: "driver_whatsapp_unverified", final: true };
      to = digits(d.phone); lastInbound = d.lastInboundAt;
      message = { type: "text", text: kind.endsWith("assigned")
        ? say(locale, "nAssigned", { ref: ctx.reference, route: route(locale), when: when(ctx.pickupAt, locale), url: `${app}/chofer` })
        : say(locale, "nReleased", { ref: ctx.reference }) };
      params = [ctx.reference, when(ctx.pickupAt, locale)];
      break;
    }
    default:
      return { send: false, reason: "unknown_kind", final: true };
  }

  if (!to || to.length < 6) return { send: false, reason: "no_phone", final: true };
  if (inWindow(lastInbound)) return { send: true, to, message: message!, conversationPhone: `+${to}` };
  const tpl = opts.templates[kind];
  if (!tpl) return { send: false, reason: "no_template", final: true };
  const m: Outbound = { type: "template", name: tpl.name, language: tpl.language, params,
    ...(kind === "notify.driver.offer" && ctx.offer ? { buttonPayloads: [`offer:${ctx.offer.id}:a`, `offer:${ctx.offer.id}:d`] } : {}) };
  return { send: true, to, message: m, conversationPhone: `+${to}` };
}
