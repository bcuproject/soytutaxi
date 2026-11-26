import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { addDaysLocal, utcToLocalDate } from "@shared/domain/time.ts";
import type { Direction, FareBreakdown, NormalizedJourney, PaymentMode, VehicleClass, VehicleOption } from "@shared/domain/types.ts";
import { Badge, Button, Counter, Field, Input, Select } from "../components/ui";
import { ApiFailure, backend } from "../lib/backend";
import { cx, fmtLocalDate, fmtTime, formatMoney } from "../lib/format";
import { useI18n, type T } from "../lib/i18n";

export interface PublicConfig {
  operator: { name: string; demoMode: boolean };
  vehicleClasses: VehicleClass[];
  airports: { iata: string; name: string; meetingPointEs: string; meetingPointEn: string }[];
  zones: { code: string; name: string }[];
  policy: { isDemo: boolean; leadTimeMinutes: number; turnaroundMinutes: number; escalation: { unassigned_alert_hours_before: number }; allowedPaymentModes: PaymentMode[]; arrivalBufferMinutes: Record<string, number>; cancellation: { free_until_hours_before: number } };
}

interface QuoteResponse {
  quoteId: string;
  kind: "priced" | "manual";
  expiresAt: string;
  vehicleClass: string | null;
  vehicleOptions: VehicleOption[];
  fare: FareBreakdown | null;
  manualReasons: string[];
  review: NormalizedJourney;
  isDemo: boolean;
}

interface BookingResponse { reference: string; statusUrl: string; statusToken: string; bookingState: string }

type FieldErrors = Record<string, string>;

function errorsFrom(e: unknown, t: T, leadH: number): { fields: FieldErrors; general: string | null } {
  if (e instanceof ApiFailure) {
    const fields: FieldErrors = {};
    for (const f of e.body.fields ?? []) fields[f.field] = t(`err.${f.code}`, { h: leadH });
    const known = t(`err.${e.body.code}`);
    return { fields, general: Object.keys(fields).length ? null : known.startsWith("err.") ? t("err.generic") : known };
  }
  return { fields: {}, general: t("err.generic") };
}

export function useConfig() {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  useEffect(() => { backend.api<PublicConfig>("GET", "/config").then(setCfg).catch(() => setCfg(null)); }, []);
  return cfg;
}

export default function BookingPage({ staff = false }: { staff?: boolean }) {
  const { t, locale } = useI18n();
  const cfg = useConfig();
  const tomorrow = useMemo(() => addDaysLocal(utcToLocalDate(new Date()), 1), []);

  const [direction, setDirection] = useState<Direction>("from_airport");
  const [airport, setAirport] = useState("EZE");
  const [zoneCode, setZoneCode] = useState("");
  const [placeText, setPlaceText] = useState("");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("10:00");
  const [flight, setFlight] = useState("");
  const [passengers, setPassengers] = useState(2);
  const [largeBags, setLargeBags] = useState(2);
  const [carryOn, setCarryOn] = useState(1);

  const [step, setStep] = useState<"form" | "review" | "done">("form");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("prepaid");
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [booking, setBooking] = useState<BookingResponse | null>(null);
  const [flightException, setFlightException] = useState("");
  const authHeaders = () => (staff ? backend.staffAuthHeader() : Promise.resolve({} as Record<string, string>));
  const [nowTick, setNowTick] = useState(Date.now());
  const navigate = useNavigate();

  useEffect(() => { const i = setInterval(() => setNowTick(Date.now()), 15_000); return () => clearInterval(i); }, []);
  const leadH = Math.round((cfg?.policy.leadTimeMinutes ?? 180) / 60);
  const from = direction === "from_airport";
  const expired = quote ? new Date(quote.expiresAt).getTime() <= nowTick : false;

  async function requestQuote(vehicleClass?: string) {
    setBusy(true); setErrs({}); setGeneral(null);
    try {
      const q = await backend.api<QuoteResponse>("POST", "/quotes", {
        direction, airport, zoneCode, place: { text: placeText }, date, time,
        flightDesignator: from ? flight : null, passengers, largeBags, carryOn, vehicleClass, locale,
      }, await authHeaders());
      setQuote(q); setStep("review"); setIdemKey(crypto.randomUUID());
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      const r = errorsFrom(e, t, leadH);
      setErrs(r.fields); setGeneral(r.general);
      if (step === "review" && Object.keys(r.fields).length) setStep("form");
    } finally { setBusy(false); }
  }

  async function submitBooking(ev: FormEvent) {
    ev.preventDefault();
    if (!quote) return;
    setBusy(true); setErrs({}); setGeneral(null);
    try {
      // Same idempotency key on retry of this exact submission → safe double-click / network retry.
      const b = await backend.api<BookingResponse>("POST", "/bookings", {
        quoteId: quote.quoteId, contact: { name, phone: phone || null, email: email || null, locale }, paymentMode, notes: notes || null,
        flightExceptionReason: staff && quote.review.direction === "from_airport" && !quote.review.flight ? flightException || null : null,
      }, { ...(await authHeaders()), "idempotency-key": idemKey });
      setBooking(b); setStep("done");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      const r = errorsFrom(e, t, leadH);
      setErrs(r.fields); setGeneral(r.general);
      if (e instanceof ApiFailure && e.status === 409) setIdemKey(crypto.randomUUID());
    } finally { setBusy(false); }
  }

  if (!cfg) return <div className="py-24 text-center text-ink-400">…</div>;
  const vcLabel = (code: string | null) => {
    const v = cfg.vehicleClasses.find((x) => x.code === code);
    return v ? (locale === "en" ? v.labelEn : v.labelEs) : code ?? "—";
  };

  // ---------------------------------------------------------------- done
  if (step === "done" && booking && quote) {
    return (
      <div className="mx-auto max-w-xl px-5 py-12">
        <div className="rounded-3xl border border-ink-700 bg-ink-900 p-8">
          <div className="mb-5 grid h-12 w-12 place-items-center rounded-full bg-amber-500/15 text-amber-300" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          </div>
          <h1 className="text-2xl font-semibold">{t("done.title")}</h1>
          <p className="mt-2 text-ink-300">{t("done.body")}</p>
          <div className="mt-6 rounded-2xl bg-ink-800 p-5">
            <div className="text-xs uppercase tracking-wide text-ink-400">{t("done.reference")}</div>
            <div className="mt-1 font-mono text-3xl font-bold tracking-wider text-cab-400" data-testid="booking-ref">{booking.reference}</div>
            <div className="mt-3"><Badge tone="needs_driver">{t("state.needs_driver")}</Badge></div>
          </div>
          <TripSummary j={quote.review} t={t} locale={locale} vehicle={vcLabel(quote.vehicleClass)} />
          <div className="mt-6 flex flex-wrap gap-3">
            {staff
              ? <Button onClick={() => navigate("/despacho")}>Volver a despacho</Button>
              : <Button onClick={() => navigate(`/reserva/${booking.reference}?t=${booking.statusToken}`)}>{t("done.status")}</Button>}
            <Button variant="outline" onClick={() => { setStep("form"); setQuote(null); setBooking(null); }}>{t("done.new")}</Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- review
  if (step === "review" && quote) {
    const minutesLeft = Math.max(0, Math.round((new Date(quote.expiresAt).getTime() - nowTick) / 60000));
    return (
      <div className="mx-auto grid max-w-5xl gap-6 px-5 py-10 lg:grid-cols-[1.1fr_1fr]">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-2xl font-semibold">{t("quote.title")}</h1>
            <Button variant="ghost" onClick={() => setStep("form")}>← {t("quote.edit")}</Button>
          </div>
          <div className="rounded-3xl border border-ink-700 bg-ink-900 p-6">
            <TripSummary j={quote.review} t={t} locale={locale} />
            <p className="mt-4 rounded-xl bg-ink-800 px-4 py-3 text-sm text-ink-300">
              {quote.review.flight
                ? t("quote.pickupFrom", { time: fmtTime(quote.review.pickupAt, locale), buffer: quote.review.flight.bufferMinutes })
                : t("quote.pickupTo", { time: fmtTime(quote.review.pickupAt, locale) })}
            </p>
          </div>

          <h2 className="mb-3 mt-8 text-xs font-medium uppercase tracking-wide text-ink-300">{t("quote.vehicle")}</h2>
          <div className="grid gap-3" role="radiogroup">
            {quote.vehicleOptions.map((o) => {
              const vc = cfg.vehicleClasses.find((v) => v.code === o.code)!;
              const selected = o.code === quote.vehicleClass;
              return (
                <button key={o.code} type="button" role="radio" aria-checked={selected} disabled={!o.eligible || busy || selected}
                  onClick={() => requestQuote(o.code)} data-testid={`vehicle-${o.code}`}
                  className={cx("flex items-center gap-4 rounded-2xl border p-4 text-left transition",
                    selected ? "border-cab-500 bg-cab-500/5" : "border-ink-700 bg-ink-900",
                    o.eligible && !selected && "hover:border-ink-400", !o.eligible && "opacity-50")}>
                  <span className={cx("h-4 w-4 shrink-0 rounded-full border-2", selected ? "border-cab-500 bg-cab-500" : "border-ink-600")} />
                  <span className="flex-1">
                    <span className="block font-semibold">{locale === "en" ? vc.labelEn : vc.labelEs}</span>
                    <span className="block text-xs text-ink-400">
                      {vc.maxPassengers} pax · {vc.maxLargeBags} {t("form.largeBags").toLowerCase()} · {vc.maxCarryOn} {t("form.carryOn").toLowerCase()}
                    </span>
                    {!o.eligible && <span className="mt-1 block text-xs text-red-300">{o.reasons.map((r) => t(`reason.${r}`)).join(" · ")}</span>}
                  </span>
                  <span className="text-right text-sm font-semibold tabular-nums">
                    {o.amountMinor !== null ? formatMoney(o.amountMinor, o.currency!, locale) : <span className="text-xs text-ink-400">{t("quote.noPrice")}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          {quote.kind === "manual" ? (
            <div className="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-6">
              <h2 className="text-lg font-semibold text-amber-200">{t("quote.manual.title")}</h2>
              <p className="mt-2 text-sm text-ink-300">{t("quote.manual.body")}</p>
              <a className="mt-4 inline-block" href="https://wa.me/5491163692528" target="_blank" rel="noreferrer"><Button>WhatsApp</Button></a>
            </div>
          ) : (
            <form onSubmit={submitBooking} className="rounded-3xl border border-ink-700 bg-ink-900 p-6" noValidate>
              <div className="flex items-end justify-between border-b border-ink-700 pb-5">
                <div>
                  <div className="text-xs uppercase tracking-wide text-ink-400">{t("quote.total")}</div>
                  <div className="text-3xl font-bold tabular-nums" data-testid="quote-total">{formatMoney(quote.fare!.totalMinor, quote.fare!.currency, locale)}</div>
                  <div className="mt-1 text-xs text-ink-400">{vcLabel(quote.vehicleClass)}</div>
                </div>
                <div className="text-right">
                  {quote.fare!.isDemo && <Badge tone="warn">{t("quote.demoFare")}</Badge>}
                  <div className={cx("mt-1 text-xs", expired ? "text-red-400" : "text-ink-400")}>{expired ? t("quote.expired") : t("quote.expires", { min: minutesLeft })}</div>
                </div>
              </div>

              <h2 className="mb-4 mt-5 text-xs font-medium uppercase tracking-wide text-ink-300">{t("contact.title")}</h2>
              <div className="grid gap-4">
                <Field label={t("contact.name")} error={errs["contact.name"]}>
                  <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" invalid={!!errs["contact.name"]} required />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("contact.phone")} hint={t("contact.phone.hint")} error={errs["contact.phone"]}>
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" autoComplete="tel" placeholder="+54 9 11 …" invalid={!!errs["contact.phone"]} />
                  </Field>
                  <Field label={t("contact.email")} error={errs["contact.email"]}>
                    <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" invalid={!!errs["contact.email"]} />
                  </Field>
                </div>
                <Field label={t("contact.notes")}>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000}
                    className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-sm focus:border-cab-500 focus:outline-none focus:ring-2 focus:ring-cab-500/30" />
                </Field>
                {staff && quote.review.direction === "from_airport" && !quote.review.flight && (
                  <Field label="Motivo sin número de vuelo (staff)" hint="Queda registrado en la auditoría de la reserva." error={errs.flightExceptionReason}>
                    <Input value={flightException} onChange={(e) => setFlightException(e.target.value)} placeholder="Ej.: vuelo privado / charter" data-testid="flight-exception" />
                  </Field>
                )}
                <fieldset>
                  <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-300">{t("contact.payment")}</legend>
                  <div className="grid gap-2">
                    {cfg.policy.allowedPaymentModes.map((m) => (
                      <label key={m} className={cx("flex cursor-pointer gap-3 rounded-xl border p-3", paymentMode === m ? "border-cab-500 bg-cab-500/5" : "border-ink-700")}>
                        <input type="radio" name="pay" className="mt-1 accent-[#f5c400]" checked={paymentMode === m} onChange={() => setPaymentMode(m)} />
                        <span><span className="block text-sm font-medium">{t(`pay.${m}`)}</span><span className="block text-xs text-ink-400">{t(`pay.${m}.hint`)}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {general && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{general}</p>}
              {expired
                ? <Button type="button" className="mt-6 w-full" onClick={() => requestQuote(quote.vehicleClass ?? undefined)} disabled={busy}>{t("form.submit")}</Button>
                : <Button type="submit" className="mt-6 w-full" disabled={busy} data-testid="submit-booking">{busy ? "…" : t("contact.submit")}</Button>}
              <p className="mt-3 text-center text-xs text-ink-400">{t("contact.terms", { hours: cfg.policy.cancellation.free_until_hours_before })}</p>
            </form>
          )}
        </section>
      </div>
    );
  }

  // ---------------------------------------------------------------- form
  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      {staff && <Link to="/despacho" className="mb-4 inline-block text-sm text-ink-400 hover:text-white">← Despacho</Link>}
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{staff ? "Nueva reserva (despacho)" : t("form.title")}</h1>
      <p className="mt-2 max-w-xl text-ink-300">{t("form.subtitle")}</p>

      <form onSubmit={(e) => { e.preventDefault(); requestQuote(); }} className="mt-8 rounded-3xl border border-ink-700 bg-ink-900/60 p-5 sm:p-7" noValidate>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-ink-800 p-1" role="tablist">
          {(["from_airport", "to_airport"] as Direction[]).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={direction === d} onClick={() => setDirection(d)}
              className={cx("rounded-lg py-2.5 text-sm font-semibold transition", direction === d ? "bg-cab-500 text-ink-950" : "text-ink-300 hover:text-white")}>
              {t(d === "from_airport" ? "form.direction.from" : "form.direction.to")}
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-5">
          <div>
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-300">{t("form.airport")}</span>
            <div className="grid grid-cols-2 gap-3">
              {cfg.airports.map((a) => (
                <button key={a.iata} type="button" onClick={() => setAirport(a.iata)} aria-pressed={airport === a.iata}
                  className={cx("rounded-xl border p-3 text-left transition", airport === a.iata ? "border-cab-500 bg-cab-500/5" : "border-ink-700 hover:border-ink-400")}>
                  <span className="block font-mono text-lg font-bold">{a.iata}</span>
                  <span className="block truncate text-xs text-ink-400">{a.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-[1fr_1.4fr]">
            <Field label={t("form.zone")} error={errs.zoneCode}>
              <Select value={zoneCode} onChange={(e) => setZoneCode(e.target.value)} invalid={!!errs.zoneCode} data-testid="zone">
                <option value="">{t("form.zone.placeholder")}</option>
                {cfg.zones.map((z) => <option key={z.code} value={z.code}>{z.name}</option>)}
              </Select>
            </Field>
            <Field label={t(from ? "form.address.from" : "form.address.to")} hint={t("form.address.hint")} error={errs["place.text"] ?? errs["place.coordinates"]}>
              <Input value={placeText} onChange={(e) => setPlaceText(e.target.value)} invalid={!!errs["place.text"]} autoComplete="street-address" data-testid="address" />
            </Field>
          </div>

          <div className={cx("grid gap-5", from ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            <Field label={t(from ? "form.date.from" : "form.date.to")} error={errs.date}>
              <Input type="date" value={date} min={utcToLocalDate(new Date())} onChange={(e) => setDate(e.target.value)} invalid={!!errs.date} />
            </Field>
            <Field label={t(from ? "form.time.from" : "form.time.to")} error={errs.time}>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} invalid={!!errs.time} />
            </Field>
            {from && (
              <Field label={t("form.flight")} error={errs.flightDesignator}>
                <Input value={flight} onChange={(e) => setFlight(e.target.value.toUpperCase())} placeholder="AR1303" invalid={!!errs.flightDesignator} data-testid="flight" />
              </Field>
            )}
          </div>
          {from && <p className="-mt-3 text-xs text-ink-400">{t("form.flight.hint")}</p>}
          {date && <p className="-mt-2 text-xs text-ink-400">{fmtLocalDate(date, locale)}</p>}

          <div className="grid gap-4 sm:grid-cols-3">
            <Counter label={t("form.passengers")} value={passengers} min={1} max={15} onChange={setPassengers} error={errs.passengers} />
            <Counter label={t("form.largeBags")} value={largeBags} min={0} max={15} onChange={setLargeBags} error={errs.largeBags} />
            <Counter label={t("form.carryOn")} value={carryOn} min={0} max={15} onChange={setCarryOn} error={errs.carryOn} />
          </div>
        </div>

        {general && <p role="alert" className="mt-5 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{general}</p>}
        <Button type="submit" className="mt-7 w-full text-base" disabled={busy} data-testid="get-quote">{busy ? "…" : t("form.submit")}</Button>
      </form>
      {!staff && <p className="mt-6 text-center text-xs text-ink-500"><Link to="/despacho" className="text-ink-400 hover:text-white">Despacho →</Link></p>}
      {staff && <p className="mt-4 text-center text-xs text-ink-400">Como despacho podés cargar un traslado desde el aeropuerto sin número de vuelo; se pide el motivo al confirmar.</p>}
    </div>
  );
}

export function TripSummary({ j, t, locale, vehicle }: { j: NormalizedJourney; t: T; locale: string; vehicle?: string }) {
  const row = "grid grid-cols-[88px_1fr] gap-3 py-2 text-sm";
  return (
    <dl className="mt-5 divide-y divide-ink-800">
      <div className={row}><dt className="text-ink-400">{t("summary.from")}</dt><dd>{j.pickup.label}</dd></div>
      <div className={row}><dt className="text-ink-400">{t("summary.to")}</dt><dd>{j.dropoff.label}</dd></div>
      <div className={row}><dt className="text-ink-400">{t("summary.when")}</dt><dd className="first-letter:uppercase">{fmtLocalDate(j.pickupLocalDate, locale)} · {fmtTime(j.pickupAt, locale)}</dd></div>
      {j.flight && <div className={row}><dt className="text-ink-400">{t("summary.flight")}</dt><dd className="font-mono">{j.flight.designator} · {j.flight.scheduledArrivalLocal}</dd></div>}
      <div className={row}><dt className="text-ink-400">{t("quote.vehicle")}</dt><dd>{vehicle ? `${vehicle} · ` : ""}{t("summary.people", { n: j.passengers, l: j.largeBags, c: j.carryOn })}</dd></div>
    </dl>
  );
}
