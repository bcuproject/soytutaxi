// WhatsApp booking conversation. Pure logic: takes the stored conversation + one inbound message and
// returns the replies and the new state. Fares, validation and booking creation go through the same
// computeQuote / Store commands as the website, so WhatsApp can never price or book differently.

import { canonicalJson, deriveStatusToken, sessionHash, sha256Hex } from "../domain/crypto.ts";
import { formatMoney } from "../domain/fare.ts";
import { zonesContaining } from "../domain/geo.ts";
import { computeQuote } from "../domain/quote.ts";
import { addDaysLocal, addMinutes, utcToLocalDate } from "../domain/time.ts";
import type { Direction, Locale, OperatorConfig, PaymentMode, VehicleOption } from "../domain/types.ts";
import { ApiError, type CancelTerms, type Store } from "../api/store.ts";
import type { Extractor } from "./ai.ts";
import { say } from "./copy.ts";
import type { InboundMessage, Outbound } from "./meta.ts";
import {
  extractAll, parseCount, parseDate, parseFlight, parseTime, strip, wantsCancel, wantsMenu, wantsStaff, wantsStatus,
  type Extracted,
} from "./parse.ts";

export type Step =
  | "menu" | "direction" | "airport" | "zone" | "address" | "date" | "date_pick" | "time" | "flight"
  | "passengers" | "bags" | "carry" | "review" | "change" | "vehicle" | "name" | "payment" | "done" | "handoff" | "rate_comment";

export interface Draft {
  direction?: Direction;
  airport?: string;
  zoneCode?: string;
  placeText?: string;
  lat?: number;
  lng?: number;
  date?: string;
  dateOptions?: string[];
  time?: string;
  flight?: string;
  passengers?: number;
  largeBags?: number;
  carryOn?: number;
  vehicleClass?: string;
  name?: string;
  paymentMode?: PaymentMode;
  quoteId?: string;
  quoteExpiresAt?: string;
  options?: VehicleOption[];
  lastRef?: string;
  lastUrl?: string;
  staffNotified?: boolean;
  /** Booking waiting for a comment after a low rating. */
  rateBooking?: string;
  rateScore?: number;
}

export interface ConversationState {
  id: string;
  operatorId: string;
  waId: string;
  profileName?: string | null;
  kind: "passenger" | "driver";
  driverId?: string | null;
  locale: Locale;
  step: Step;
  draft: Draft;
}

export interface BookingSummary {
  reference: string; state: string; pickupAt: string; direction: Direction; airport: string; zone: string | null; idempotencyKey: string;
}

export interface EngineDeps {
  cfg: OperatorConfig;
  now: Date;
  store: Store;
  ai?: Extractor | null;
  statusTokenSecret: string;
  publicAppUrl: string;
  bookingsForPhone(phone: string): Promise<BookingSummary[]>;
  driverRespond?(driverId: string, offerId: string, accept: boolean): Promise<{ outcome: string; reference?: string }>;
  /** Passenger self-service; confirm=false returns the terms only. */
  cancelBooking?(phone: string, reference: string, confirm: boolean): Promise<CancelTerms & { cancelled?: boolean }>;
  rate?(phone: string, bookingId: string, score: number, comment: string | null): Promise<{ score: number }>;
}

export interface EngineResult {
  replies: Outbound[];
  step: Step;
  draft: Draft;
  locale: Locale;
  needsStaff?: boolean;
  bookingId?: string;
}

const FIELD_ORDER = ["direction", "airport", "zoneCode", "placeText", "date", "time", "flight", "passengers", "largeBags", "carryOn"] as const;
const QUOTE_FIELDS: (keyof Draft)[] = ["direction", "airport", "zoneCode", "placeText", "lat", "lng", "date", "time", "flight", "passengers", "largeBags", "carryOn", "vehicleClass"];
const YES = /^(si|sí|s|yes|y|ok|okay|dale|confirmo|confirmar|confirm|listo|perfecto|correcto|de una)[!. ]*$/;

export async function handleMessage(conv: ConversationState, msg: InboundMessage, deps: EngineDeps): Promise<EngineResult> {
  const ctx = new Turn(conv, msg, deps);
  try {
    if (conv.kind === "driver") await ctx.driver();
    else await ctx.passenger();
  } catch (e) {
    console.error(JSON.stringify({ level: "error", where: "wa-engine", conv: conv.id, error: String((e as Error)?.message ?? e).slice(0, 300) }));
    ctx.replies = [{ type: "text", text: say(ctx.locale, "error") }];
  }
  return { replies: ctx.replies, step: ctx.step, draft: ctx.draft, locale: ctx.locale, needsStaff: ctx.needsStaff, bookingId: ctx.bookingId };
}

class Turn {
  replies: Outbound[] = [];
  step: Step;
  draft: Draft;
  locale: Locale;
  needsStaff?: boolean;
  bookingId?: string;
  today: string;
  text: string;
  id: string;

  constructor(private conv: ConversationState, private msg: InboundMessage, private deps: EngineDeps) {
    this.step = conv.step;
    this.draft = { ...conv.draft };
    this.locale = conv.locale;
    this.today = utcToLocalDate(deps.now, deps.cfg.timezone);
    this.text = msg.type === "text" ? (msg.text ?? "").trim() : "";
    this.id = msg.type === "reply" ? (msg.replyId ?? "") : "";
  }

  private t(key: Parameters<typeof say>[1], vars: Record<string, string | number> = {}) { return say(this.locale, key, vars); }
  private textOut(text: string) { this.replies.push({ type: "text", text }); }
  private get phone() { return `+${this.conv.waId}`; }

  // ------------------------------------------------------------------------------- drivers
  async driver() {
    const m = /^offer:([0-9a-f-]{36}):(a|d)$/.exec(this.id);
    const app = `${this.deps.publicAppUrl.replace(/\/$/, "")}/chofer`;
    if (m && this.conv.driverId && this.deps.driverRespond) {
      try {
        const r = await this.deps.driverRespond(this.conv.driverId, m[1], m[2] === "a");
        this.textOut(r.outcome === "accepted" ? this.t("offerAccepted", { ref: r.reference ?? "", url: app })
          : r.outcome === "declined" ? this.t("offerDeclined")
          : r.outcome === "expired" ? this.t("offerExpired") : this.t("offerTaken"));
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

    // Language switch
    if (/^(en|english|ingles)$/.test(plain) || this.id === "lang:en") { this.locale = "en"; return this.resume(); }
    if (/^(es|espanol|castellano)$/.test(plain) || this.id === "lang:es") { this.locale = "es-AR"; return this.resume(); }

    // Ratings and self-service cancellation
    const rm = /^rate:([0-9a-f-]{36}):([1-5])$/.exec(this.id);
    if (rm && this.deps.rate) return this.rate(rm[1], +rm[2], null);
    if (this.step === "rate_comment" && this.text && this.draft.rateBooking && this.deps.rate && !wantsStaff(this.text)) {
      return this.rate(this.draft.rateBooking, this.draft.rateScore ?? 1, this.text);
    }
    const cm = /^bk:(cancel|cancelok|keep):([A-Z0-9-]{4,20})$/.exec(this.id);
    if (cm && this.deps.cancelBooking) return this.selfCancel(cm[2], cm[1]);

    // Global commands
    if (this.id === "menu:staff" || this.id === "review:staff" || (this.text && wantsStaff(this.text))) return this.handoff("staffOn");
    if (this.id === "change:cancel" || (this.text && wantsCancel(this.text))) {
      this.resetDraft();
      this.textOut(this.t("cancelled"));
      return this.menu(false);
    }
    if (this.id === "menu:check" || (this.text && wantsStatus(this.text) && ["menu", "done", "handoff"].includes(this.step))) return this.listBookings();
    if (this.step === "handoff" && !this.id.startsWith("menu:") && !wantsMenu(this.text)) {
      if (!this.draft.staffNotified) { this.draft.staffNotified = true; this.textOut(this.t("staffWait")); }
      return;
    }
    if (this.id === "menu:book") { this.resetDraft(); this.step = "direction"; return this.next(); }

    // Button / list replies carry exact values.
    if (this.id) return this.applyReply();

    if (this.msg.type === "location" && this.msg.location) return this.applyLocation();
    if (this.msg.type === "other") { this.textOut(this.t("unsupported")); return; }

    // Free text
    const extracted = await this.understand();
    if (extracted.language && ["menu", "done"].includes(this.step) && !this.hasAnyField()) this.locale = extracted.language;
    const captured = this.applyStepText(extracted);
    const changed = this.merge(extracted);

    if (["menu", "done", "handoff"].includes(this.step) && !changed && !captured) {
      if (this.step === "done" && this.draft.lastRef && !wantsMenu(this.text)) return this.menu(false);
      return this.menu(true);
    }
    if (this.step === "review" && YES.test(plain)) return this.confirm();
    if (["menu", "done", "handoff"].includes(this.step)) this.step = "direction";
    return this.next();
  }

  private hasAnyField() { return FIELD_ORDER.some((f) => this.draft[f] !== undefined); }

  private resetDraft() {
    this.draft = { name: this.draft.name, lastRef: this.draft.lastRef, lastUrl: this.draft.lastUrl };
  }

  private clearQuote() {
    delete this.draft.quoteId; delete this.draft.quoteExpiresAt; delete this.draft.options;
  }

  /** Re-ask the current question in the new language, or show the menu. */
  private async resume() {
    if (["menu", "done", "handoff"].includes(this.step) || !this.hasAnyField()) return this.menu(true);
    return this.next();
  }

  private menu(withWelcome: boolean) {
    this.step = "menu";
    const name = this.conv.profileName ? ` ${this.conv.profileName.split(/\s+/)[0]}` : "";
    this.replies.push({
      type: "buttons",
      text: withWelcome ? this.t("welcome", { name }) : this.t("menuShort"),
      footer: this.t("langHint"),
      buttons: [
        { id: "menu:book", title: this.t("menuBook") },
        { id: "menu:check", title: this.t("menuCheck") },
        { id: "menu:staff", title: this.t("menuStaff") },
      ],
    });
  }

  private handoff(key: "staffOn" | "manual" | "noVehicle", vars: Record<string, string | number> = {}) {
    this.step = "handoff";
    this.needsStaff = true;
    this.draft.staffNotified = true;
    this.textOut(this.t(key, vars));
  }

  private statusUrl(reference: string, token: string) {
    return `${this.deps.publicAppUrl.replace(/\/$/, "")}/reserva/${reference}?t=${token}`;
  }

  private async listBookings() {
    const list = await this.deps.bookingsForPhone(this.phone);
    if (!list.length) { this.textOut(this.t("noBookings")); return this.menu(false); }
    const lines = await Promise.all(list.map(async (b) => {
      const token = await deriveStatusToken(this.deps.statusTokenSecret, this.deps.cfg.operatorId, b.idempotencyKey);
      return this.t("bookingLine", {
        ref: b.reference, when: this.when(b.pickupAt),
        route: b.direction === "from_airport" ? `${b.airport} → ${b.zone ?? ""}` : `${b.zone ?? ""} → ${b.airport}`,
        state: this.t(`state_${b.state}` as never) || b.state, url: this.statusUrl(b.reference, token),
      });
    }));
    this.textOut(`${this.t("bookingsHeader")}\n\n${lines.join("\n\n")}`);
    const open = list.filter((b) => !["cancelled", "closed"].includes(b.state)).slice(0, 3);
    if (this.deps.cancelBooking && open.length) {
      this.replies.push({ type: "buttons", text: this.t("menuShort"),
        buttons: open.map((b) => ({ id: `bk:cancel:${b.reference}`, title: this.t("btnCancelRef", { ref: b.reference }) })) });
    }
    if (this.step !== "handoff") this.step = "done";
  }

  private money(minor: number, currency: string | null) {
    return currency ? formatMoney(minor, currency, this.locale) : String(minor);
  }

  private async selfCancel(reference: string, action: string) {
    this.step = "done";
    if (action === "keep") { this.textOut(this.t("cancelKept")); return; }
    try {
      const t = await this.deps.cancelBooking!(this.phone, reference, action === "cancelok");
      if (!t.allowed && !t.cancelled) {
        this.textOut(this.t("cancelRefused", { ref: reference, why: this.t(`why_${t.reason}` as never) || String(t.reason) }));
        return;
      }
      if (t.cancelled) {
        this.textOut(t.refundMinor > 0 ? this.t("cancelDoneRefund", { ref: reference, amount: this.money(t.refundMinor, t.currency) })
          : this.t("cancelDone", { ref: reference }));
        return;
      }
      const hours = t.freeUntilHoursBefore;
      const refund = t.paidMinor <= 0 ? (t.refundPercent === 100 || t.paymentMode !== "prepaid" ? this.t("cancelFree") : this.t("cancelNoRefund", { hours }))
        : t.refundMinor <= 0 ? this.t("cancelNoRefund", { hours })
        : t.refundPercent === 100 ? this.t("cancelRefundFull", { amount: this.money(t.refundMinor, t.currency) })
        : this.t("cancelRefundPart", { hours, pct: t.refundPercent, amount: this.money(t.refundMinor, t.currency) });
      this.replies.push({ type: "buttons", text: this.t("cancelAsk", { ref: reference, when: this.when(t.pickupAt), refund }),
        buttons: [{ id: `bk:cancelok:${reference}`, title: this.t("btnCancelYes") }, { id: `bk:keep:${reference}`, title: this.t("btnCancelNo") }] });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      this.textOut(this.t("cancelRefused", { ref: reference, why: this.t(`why_${code}` as never) || code }));
    }
  }

  private async rate(bookingId: string, score: number, comment: string | null) {
    try {
      await this.deps.rate!(this.phone, bookingId, score, comment);
      if (comment) { this.textOut(this.t("rateCommentThanks")); this.step = "done"; delete this.draft.rateBooking; delete this.draft.rateScore; }
      else if (score <= 2) { this.textOut(this.t("rateAskComment")); this.step = "rate_comment"; this.draft.rateBooking = bookingId; this.draft.rateScore = score; }
      else { this.textOut(this.t("rateThanks")); this.step = "done"; }
    } catch (e) {
      this.textOut(this.t("rateError", { reason: e instanceof ApiError ? e.code : "error" }));
      this.step = "done"; delete this.draft.rateBooking;
    }
  }

  // ------------------------------------------------------------------------------- understanding
  private async understand(): Promise<Extracted> {
    const cfg = this.deps.cfg;
    const e = extractAll(this.text, cfg.zones, this.today, this.locale);
    const words = this.text.split(/\s+/).filter(Boolean).length;
    const useAi = this.deps.ai && words >= 4 && !["name", "address", "time", "flight"].includes(this.step);
    if (!useAi) return e;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, weekday: "long" }).format(this.deps.now);
    const ai = await this.deps.ai!.extract(this.text, {
      today: this.today, weekday, locale: this.locale, awaiting: this.step,
      zones: cfg.zones.filter((z) => z.active).map((z) => ({ code: z.code, name: z.name })),
    });
    if (!ai) return e;
    // Deterministic parsers win on conflicts; AI values are re-validated before use.
    if (!e.direction && (ai.direction === "from_airport" || ai.direction === "to_airport")) e.direction = ai.direction;
    if (!e.airport && (ai.airport === "EZE" || ai.airport === "AEP")) e.airport = ai.airport;
    if (!e.zoneCode && ai.zone && cfg.zones.some((z) => z.active && z.code === ai.zone)) e.zoneCode = ai.zone;
    if (!e.placeText && ai.address && String(ai.address).trim().length >= 3) e.placeText = String(ai.address).trim().slice(0, 200);
    if (!e.date && !e.dateOptions && ai.date && parseDate(String(ai.date), this.today, "es-AR")?.date) e.date = parseDate(String(ai.date), this.today, "es-AR")!.date;
    if (!e.time && ai.time) { const tm = parseTime(String(ai.time)); if (tm) e.time = tm; }
    if (!e.flight && ai.flight) { const f = parseFlight(String(ai.flight)); if (f) e.flight = f; }
    const n = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : undefined);
    if (e.passengers === undefined && n(ai.passengers, 60)) e.passengers = n(ai.passengers, 60);
    if (e.largeBags === undefined && n(ai.large_bags, 60) !== undefined) e.largeBags = n(ai.large_bags, 60);
    if (e.carryOn === undefined && n(ai.carry_on, 60) !== undefined) e.carryOn = n(ai.carry_on, 60);
    if (!e.language && (ai.language === "en" || ai.language === "es")) e.language = ai.language === "en" ? "en" : "es-AR";
    if (ai.wants_staff === true) e.wantsStaff = true;
    return e;
  }

  /** Text that answers exactly the question being asked (a bare number, an address, a name…). */
  private applyStepText(e: Extracted): boolean {
    const t = this.text;
    switch (this.step) {
      case "address":
        if (t.length >= 3 && !e.placeText) { this.draft.placeText = t.slice(0, 200); this.clearQuote(); return true; }
        return false;
      case "name":
        if (t.length >= 2) { this.draft.name = t.slice(0, 120); return true; }
        return false;
      case "passengers": case "bags": case "carry": {
        const num = /^\s*(\d{1,2})\s*$/.exec(t);
        const key = this.step === "passengers" ? "passengers" : this.step === "bags" ? "largeBags" : "carryOn";
        const v = num ? +num[1] : parseCount(t, this.step === "passengers" ? "passengers" : this.step === "bags" ? "large" : "carry");
        if (v !== null && (this.step !== "passengers" || v >= 1)) { (this.draft as Record<string, unknown>)[key] = v; this.clearQuote(); return true; }
        return false;
      }
      case "time": {
        const tm = parseTime(t);
        if (tm) { this.draft.time = tm; this.clearQuote(); return true; }
        if (!e.date && !e.flight) this.textOut(this.t("badTime"));
        return false;
      }
      case "flight": {
        const f = parseFlight(t);
        if (f) { this.draft.flight = f; this.clearQuote(); return true; }
        this.textOut(this.t("badFlight"));
        return false;
      }
      case "date": case "date_pick": {
        if (!e.date && !e.dateOptions) { this.textOut(this.t("badDate")); }
        return false;
      }
      default:
        return false;
    }
  }

  /** Merge extracted details; the passenger's latest statement wins. Returns true if anything changed. */
  private merge(e: Extracted): boolean {
    let changed = false;
    const set = <K extends keyof Draft>(k: K, v: Draft[K] | undefined) => {
      if (v === undefined || this.draft[k] === v) return;
      this.draft[k] = v;
      changed = true;
      if (QUOTE_FIELDS.includes(k)) this.clearQuote();
    };
    set("direction", e.direction);
    set("airport", e.airport);
    if (e.zoneCode && e.zoneCode !== this.draft.zoneCode) { delete this.draft.lat; delete this.draft.lng; }
    set("zoneCode", e.zoneCode);
    if (e.placeText && this.step !== "address") set("placeText", e.placeText);
    if (e.dateOptions) { this.draft.dateOptions = e.dateOptions; changed = true; }
    set("date", e.date);
    set("time", e.time);
    set("flight", e.flight);
    set("passengers", e.passengers);
    set("largeBags", e.largeBags);
    set("carryOn", e.carryOn);
    if (e.wantsStaff) { this.needsStaff = true; }
    return changed;
  }

  private applyLocation() {
    const { lat, lng, name, address } = this.msg.location!;
    const z = zonesContaining(lng, lat, this.deps.cfg.zones)[0];
    if (!z) { this.textOut(this.t("outside")); this.step = "zone"; return this.next(); }
    this.draft.zoneCode = z.code;
    this.draft.lat = lat; this.draft.lng = lng;
    this.draft.placeText = [name, address].filter(Boolean).join(", ").slice(0, 200) || (this.locale === "en" ? "📍 Shared location" : "📍 Ubicación enviada");
    this.clearQuote();
    if (["menu", "done"].includes(this.step)) this.step = "direction";
    return this.next();
  }

  private async applyReply() {
    const [kind, val] = [this.id.split(":")[0], this.id.slice(this.id.indexOf(":") + 1)];
    const cfg = this.deps.cfg;
    switch (kind) {
      case "dir": if (val === "from_airport" || val === "to_airport") { this.draft.direction = val; this.clearQuote(); } break;
      case "ap": if (cfg.airports.some((a) => a.active && a.iata === val)) { this.draft.airport = val; this.clearQuote(); } break;
      case "zone":
        if (cfg.zones.some((z) => z.active && z.code === val)) {
          if (this.draft.zoneCode !== val) { delete this.draft.lat; delete this.draft.lng; delete this.draft.placeText; }
          this.draft.zoneCode = val; this.clearQuote();
        }
        break;
      case "date":
        this.draft.date = val === "today" ? this.today : val === "tomorrow" ? addDaysLocal(this.today, 1) : val;
        delete this.draft.dateOptions; this.clearQuote();
        break;
      case "pax": if (val === "more") { this.step = "passengers"; this.textOut(this.t("askPassengers")); return; }
        this.draft.passengers = +val; this.clearQuote(); break;
      case "bags": this.draft.largeBags = +val; this.clearQuote(); break;
      case "carry": this.draft.carryOn = +val; this.clearQuote(); break;
      case "review":
        if (val === "confirm") return this.confirm();
        if (val === "change") return this.askChange();
        break;
      case "change":
        if (val === "route") { for (const k of ["direction", "airport", "zoneCode", "placeText", "lat", "lng", "flight"] as const) delete this.draft[k]; }
        if (val === "when") { delete this.draft.date; delete this.draft.time; }
        if (val === "flight") delete this.draft.flight;
        if (val === "people") { delete this.draft.passengers; delete this.draft.largeBags; delete this.draft.carryOn; delete this.draft.vehicleClass; }
        if (val === "vehicle") return this.askVehicle();
        this.clearQuote();
        break;
      case "veh":
        this.draft.vehicleClass = val; this.clearQuote(); break;
      case "name":
        if (val === "profile" && this.conv.profileName) this.draft.name = this.conv.profileName.slice(0, 120);
        return this.confirm();
      case "pay":
        if (cfg.policy.config.allowed_payment_modes.includes(val as PaymentMode)) this.draft.paymentMode = val as PaymentMode;
        return this.confirm();
      default:
        return this.menu(true);
    }
    if (["menu", "done"].includes(this.step)) this.step = "direction";
    return this.next();
  }

  // ------------------------------------------------------------------------------- asking
  private validateDate(): boolean {
    const d = this.draft.date;
    if (!d) return true;
    if (d < this.today) { delete this.draft.date; this.textOut(this.t("pastDate")); return false; }
    if (d > addDaysLocal(this.today, this.deps.cfg.policy.config.max_advance_days)) {
      delete this.draft.date; this.textOut(this.t("tooFar", { days: this.deps.cfg.policy.config.max_advance_days })); return false;
    }
    return true;
  }

  private async next(): Promise<void> {
    const d = this.draft;
    this.validateDate();
    if (d.dateOptions?.length && !d.date) {
      const max = addDaysLocal(this.today, this.deps.cfg.policy.config.max_advance_days);
      const ok = d.dateOptions.filter((o) => o >= this.today && o <= max);
      if (ok.length === 1) { d.date = ok[0]; delete d.dateOptions; }
      else if (ok.length === 0) { delete d.dateOptions; this.textOut(this.t("badDate")); return this.ask("date"); }
      else { d.dateOptions = ok; return this.askDatePick(); }
    }
    for (const f of FIELD_ORDER) {
      if (f === "flight" && d.direction !== "from_airport") continue;
      if (d[f] === undefined || d[f] === "") return this.ask(f);
    }
    if (!d.quoteId || this.quoteExpired()) return this.quote(!!d.quoteId);
    return this.showReview();
  }

  private quoteExpired() { return !this.draft.quoteExpiresAt || new Date(this.draft.quoteExpiresAt) <= this.deps.now; }

  private ask(f: (typeof FIELD_ORDER)[number]) {
    const cfg = this.deps.cfg, d = this.draft;
    const n = (prefix: string, from: number, to: number, more?: boolean) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ id: `${prefix}:${from + i}`, title: String(from + i) }))
        .concat(more ? [{ id: `${prefix}:more`, title: "10+" }] : []);
    switch (f) {
      case "direction":
        this.step = "direction";
        this.replies.push({ type: "buttons", text: this.t("askDirection"), buttons: [
          { id: "dir:from_airport", title: this.t("btnFrom") }, { id: "dir:to_airport", title: this.t("btnTo") }, { id: "menu:staff", title: this.t("btnStaff") }] });
        return;
      case "airport":
        this.step = "airport";
        this.replies.push({ type: "buttons", text: this.t("askAirport"), buttons: cfg.airports.filter((a) => a.active).slice(0, 3)
          .map((a) => ({ id: `ap:${a.iata}`, title: a.iata === "EZE" ? this.t("btnEZE") : a.iata === "AEP" ? this.t("btnAEP") : a.iata })) });
        return;
      case "zoneCode":
        this.step = "zone";
        this.replies.push({ type: "list", text: this.t("askZone", { endpoint: this.t(d.direction === "to_airport" ? "endpointTo" : "endpointFrom") }),
          button: this.t("zoneButton"), rows: cfg.zones.filter((z) => z.active).slice(0, 10).map((z) => ({ id: `zone:${z.code}`, title: z.name })) });
        return;
      case "placeText":
        this.step = "address";
        this.textOut(this.t("askAddress", { zone: cfg.zones.find((z) => z.code === d.zoneCode)?.name ?? "" }));
        return;
      case "date":
        this.step = "date";
        this.replies.push({ type: "buttons", text: `${this.t("askDate", { what: this.t(d.direction === "to_airport" ? "dateTo" : "dateFrom") })}\n${this.t("dateHint")}`,
          buttons: [{ id: "date:today", title: this.t("btnToday") }, { id: "date:tomorrow", title: this.t("btnTomorrow") }] });
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

  private askDatePick() {
    this.step = "date_pick";
    this.replies.push({ type: "buttons", text: this.t("askDateWhich"),
      buttons: this.draft.dateOptions!.slice(0, 3).map((o) => ({ id: `date:${o}`, title: this.longDate(o) })) });
  }

  private askChange() {
    this.step = "change";
    const rows = [
      { id: "change:route", title: this.t("chRoute") }, { id: "change:when", title: this.t("chWhen") },
      ...(this.draft.direction === "from_airport" ? [{ id: "change:flight", title: this.t("chFlight") }] : []),
      { id: "change:people", title: this.t("chPeople") },
      ...((this.draft.options ?? []).filter((o) => o.eligible && o.amountMinor !== null).length > 1 ? [{ id: "change:vehicle", title: this.t("chVehicle") }] : []),
      { id: "change:cancel", title: this.t("chCancel") },
    ];
    this.replies.push({ type: "list", text: this.t("askChange"), button: this.t("changeButton"), rows });
  }

  private askVehicle() {
    this.step = "vehicle";
    const rows = (this.draft.options ?? []).filter((o) => o.eligible && o.amountMinor !== null).map((o) => ({
      id: `veh:${o.code}`, title: this.vehicleLabel(o.code), description: formatMoney(o.amountMinor!, o.currency!, this.locale),
    }));
    this.replies.push({ type: "list", text: this.t("askVehicle"), button: this.t("vehButton"), rows });
  }

  // ------------------------------------------------------------------------------- quote & review
  private async quote(repriced: boolean) {
    const d = this.draft, cfg = this.deps.cfg;
    const r = computeQuote({
      direction: d.direction!, airport: d.airport!, zoneCode: d.zoneCode!, place: { text: d.placeText!, lat: d.lat ?? null, lng: d.lng ?? null },
      date: d.date!, time: d.time!, flightDesignator: d.direction === "from_airport" ? d.flight : null,
      passengers: d.passengers!, largeBags: d.largeBags!, carryOn: d.carryOn!, vehicleClass: d.vehicleClass ?? null, locale: this.locale,
    }, cfg, { now: this.deps.now });

    if (r.kind === "invalid") {
      const e = r.errors[0];
      if (e.field === "time" || e.field === "date") {
        delete d.time;
        if (e.code === "too_far_ahead") { delete d.date; this.textOut(this.t("tooFar", { days: cfg.policy.config.max_advance_days })); }
        else this.textOut(this.t("tooSoon", { hours: Math.round(cfg.policy.config.lead_time_minutes / 60) }));
      } else if (e.field === "flightDesignator") { delete d.flight; this.textOut(this.t("badFlight")); }
      else if (e.field === "vehicleClass") { delete d.vehicleClass; }
      else if (e.field.startsWith("place")) { delete d.placeText; delete d.lat; delete d.lng; this.textOut(this.t("outside")); }
      else if (e.field === "zoneCode") { delete d.zoneCode; }
      else if (["passengers", "largeBags", "carryOn"].includes(e.field)) { delete (d as Record<string, unknown>)[e.field]; }
      else return this.handoff("staffOn");
      return this.next();
    }
    if (r.kind === "manual") {
      return r.reasons.includes("no_vehicle_fits") ? this.handoff("noVehicle", { pax: d.passengers! }) : this.handoff("manual");
    }

    const expiresAt = addMinutes(this.deps.now, cfg.policy.config.quote_expiry_minutes).toISOString();
    const { id } = await this.deps.store.insertQuote({
      operatorId: cfg.operatorId, sessionHash: await sessionHash(`wa:${this.conv.waId}`), source: "whatsapp", kind: "priced",
      journey: r.journey, vehicleClass: r.vehicleClass, fare: r.fare, policyId: cfg.policy.id, manualReasons: [], expiresAt,
    });
    d.quoteId = id; d.quoteExpiresAt = expiresAt; d.vehicleClass = r.vehicleClass; d.options = r.options;
    (d as Record<string, unknown>).fare = { total: r.fare.totalMinor, currency: r.fare.currency, demo: r.fare.isDemo };
    (d as Record<string, unknown>).pickupAt = r.journey.pickupAt;
    (d as Record<string, unknown>).buffer = r.journey.flight?.bufferMinutes ?? null;
    if (repriced) this.textOut(this.t("repriced"));
    return this.showReview();
  }

  private showReview() {
    const d = this.draft as Draft & { fare?: { total: number; currency: string; demo: boolean }; pickupAt?: string; buffer?: number | null };
    const cfg = this.deps.cfg;
    const zone = cfg.zones.find((z) => z.code === d.zoneCode)?.name ?? "";
    const place = `${d.placeText}${zone && !d.placeText?.includes(zone) ? ` (${zone})` : ""}`;
    const route = d.direction === "from_airport" ? this.t("routeFrom", { airport: d.airport!, place }) : this.t("routeTo", { airport: d.airport!, place });
    const mins = Math.max(1, Math.round((new Date(d.quoteExpiresAt!).getTime() - this.deps.now.getTime()) / 60000));
    this.step = "review";
    this.replies.push({
      type: "buttons",
      text: this.t("review", {
        route, when: this.when(d.pickupAt!),
        flight: d.flight ? `✈️ ${d.flight} · ${d.time}\n` : "",
        people: this.t("people", { pax: d.passengers!, bags: d.largeBags!, carry: d.carryOn! }),
        vehicle: this.vehicleLabel(d.vehicleClass!), price: formatMoney(d.fare!.total, d.fare!.currency, this.locale),
        demo: d.fare!.demo ? this.t("demo") : "", mins,
      }) + (d.buffer ? this.t("pickupNote", { buffer: d.buffer }) : ""),
      buttons: [{ id: "review:confirm", title: this.t("btnConfirm") }, { id: "review:change", title: this.t("btnChange") }, { id: "review:staff", title: this.t("btnStaff") }],
    });
  }

  // ------------------------------------------------------------------------------- booking
  private async confirm(): Promise<void> {
    const d = this.draft, cfg = this.deps.cfg;
    if (!d.quoteId && this.step === "done" && d.lastRef) {   // a second tap on an old "Confirm" button
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
        this.replies.push({ type: "buttons", text: `${this.t("askPay")}\n_${this.t("payNote")}_`,
          buttons: modes.slice(0, 3).map((m) => ({ id: `pay:${m}`, title: this.t(`pay_${m}` as never) })) });
        return;
      }
    }
    return this.book();
  }

  private async book(): Promise<void> {
    const d = this.draft, cfg = this.deps.cfg;
    const idempotencyKey = `wa:${this.msg.id}`;
    const contact = { name: d.name!, phone: this.phone, email: null, locale: this.locale };
    const token = await deriveStatusToken(this.deps.statusTokenSecret, cfg.operatorId, idempotencyKey);
    try {
      const r = await this.deps.store.createBooking({
        operatorId: cfg.operatorId, quoteId: d.quoteId!, sessionHash: await sessionHash(`wa:${this.conv.waId}`),
        idempotencyKey, requestHash: await sha256Hex(canonicalJson({ quoteId: d.quoteId, contact, paymentMode: d.paymentMode, notes: null, flightExceptionReason: null })),
        contact, paymentMode: d.paymentMode!, notes: null, statusTokenHash: await sha256Hex(token),
        actorId: null, flightExceptionReason: null, requestId: `wa-${this.msg.id}`,
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
        delete d.time; this.clearQuote();
        this.textOut(this.t("tooSoon", { hours: Math.round(cfg.policy.config.lead_time_minutes / 60) }));
        return this.next();
      }
      if (e.code === "quote_already_used" && d.lastRef) { this.textOut(this.t("booked", { ref: d.lastRef, url: d.lastUrl ?? "" })); this.step = "done"; return; }
      if (e.code === "quote_already_used" || e.code === "quote_not_found") { this.clearQuote(); return this.next(); }
      return this.handoff("staffOn");
    }
  }

  // ------------------------------------------------------------------------------- formatting
  private vehicleLabel(code: string) {
    const v = this.deps.cfg.vehicleClasses.find((x) => x.code === code);
    return v ? (this.locale === "en" ? v.labelEn : v.labelEs) : code;
  }

  private when(iso: string) {
    const lc = this.locale === "en" ? "en-GB" : "es-AR";
    const tz = this.deps.cfg.timezone;
    const day = new Intl.DateTimeFormat(lc, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
    const time = new Intl.DateTimeFormat(lc, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
    return `${day} · ${time}`;
  }

  private longDate(date: string) {
    const [y, m, dd] = date.split("-").map(Number);
    return new Intl.DateTimeFormat(this.locale === "en" ? "en-GB" : "es-AR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
      .format(new Date(Date.UTC(y, m - 1, dd, 12)));
  }
}
