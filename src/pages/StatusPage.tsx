import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { BookingStatusView, CancelTerms } from "@shared/api/store.ts";
import type { NormalizedJourney } from "@shared/domain/types.ts";
import { Badge, Button } from "../components/ui";
import { backend } from "../lib/backend";
import { fmtLocalDate, fmtTime, formatMoney } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { TripSummary, useConfig } from "./BookingPage";

const STEPS = ["needs_driver", "held", "confirmed"] as const;

export default function StatusPage() {
  const { ref = "" } = useParams();
  const [sp] = useSearchParams();
  const { t, locale } = useI18n();
  const cfg = useConfig();
  const [view, setView] = useState<BookingStatusView | null | "missing">(null);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    backend.api<BookingStatusView>("GET", `/bookings/${encodeURIComponent(ref)}`, undefined, { "x-status-token": sp.get("t") ?? "" })
      .then(setView).catch(() => setView((v) => (v && v !== "missing" ? v : "missing")));
  }, [ref, sp, tick]);
  // Back from Mercado Pago (?pago=1): the payment is confirmed by Mercado Pago's server notification,
  // never by this page, so re-read the status for a minute until it shows as paid.
  const returned = sp.get("pago") === "1";
  useEffect(() => {
    if (!returned) return;
    let n = 0;
    const i = setInterval(() => { n++; setTick((x) => x + 1); if (n >= 12) clearInterval(i); }, 5000);
    return () => clearInterval(i);
  }, [returned]);

  if (view === null) return <div className="py-24 text-center text-ink-400">…</div>;
  if (view === "missing") {
    return (
      <div className="mx-auto max-w-md px-5 py-24 text-center">
        <p className="text-ink-300">{t("status.notFound")}</p>
        {backend.mode === "demo" && <p className="mt-2 text-xs text-ink-500">Demo: las reservas viven en memoria y se pierden al recargar la página.</p>}
        <Link to="/" className="mt-6 inline-block"><Button variant="outline">{t("done.new")}</Button></Link>
      </div>
    );
  }

  const vc = cfg?.vehicleClasses.find((v) => v.code === view.vehicleClass);
  const journey = {
    pickup: view.pickup, dropoff: view.dropoff, pickupAt: view.agreedPickupAt,
    pickupLocalDate: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(view.agreedPickupAt)),
    flight: view.flight ? { designator: view.flight.designator, scheduledArrivalLocal: fmtLocalDate(view.flight.localArrivalDate, locale) } : null,
    passengers: view.passengers, largeBags: view.largeBags, carryOn: view.carryOn,
  } as unknown as NormalizedJourney;
  const stepIdx = STEPS.indexOf(view.bookingState as (typeof STEPS)[number]);

  return (
    <div className="mx-auto max-w-xl px-5 py-12">
      <div className="rounded-3xl border border-ink-700 bg-ink-900 p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-400">{t("status.title")}</div>
            <div className="mt-1 font-mono text-2xl font-bold tracking-wider text-cab-400">{view.reference}</div>
          </div>
          <Badge tone={view.bookingState}>{t(`state.${view.bookingState}`)}</Badge>
        </div>

        {view.bookingState !== "cancelled" && (
          <ol className="mt-6 grid grid-cols-3 gap-2" aria-label="progress">
            {STEPS.map((s, i) => (
              <li key={s} className="text-center">
                <div className={`h-1.5 rounded-full ${i <= stepIdx ? "bg-cab-500" : "bg-ink-700"}`} />
                <div className={`mt-2 text-[11px] ${i <= stepIdx ? "text-white" : "text-ink-400"}`}>{t(`state.${s}`)}</div>
              </li>
            ))}
          </ol>
        )}

        <TripSummary j={journey} t={t} locale={locale} vehicle={vc ? (locale === "en" ? vc.labelEn : vc.labelEs) : view.vehicleClass} />

        <div className="mt-4 flex items-center justify-between rounded-xl bg-ink-800 px-4 py-3 text-sm">
          <span className="text-ink-300">{t(`pay.${view.paymentMode}`)}</span>
          {view.amountMinor !== null && <span className="font-semibold tabular-nums">{formatMoney(view.amountMinor, view.currency!, locale)}</span>}
        </div>
        <PayNow view={view} token={sp.get("t") ?? ""} returned={returned} locale={locale} />

        {view.direction === "from_airport" && (
          <div className="mt-4 rounded-xl border border-ink-700 p-4 text-sm">
            <div className="text-xs uppercase tracking-wide text-ink-400">{t("status.meeting")} · {view.airport} · {fmtTime(view.agreedPickupAt, locale)}</div>
            <p className="mt-1 text-ink-300">{locale === "en" ? view.meetingPoint.en : view.meetingPoint.es}</p>
          </div>
        )}

        {view.allowedActions.includes("rate") || view.rating ? <RateBox view={view} token={sp.get("t") ?? ""} locale={locale} onDone={() => setTick((x) => x + 1)} /> : null}

        {view.allowedActions.includes("cancel") && <CancelBox view={view} token={sp.get("t") ?? ""} locale={locale} onDone={() => setTick((x) => x + 1)} />}

        {view.allowedActions.includes("contact_staff") && (
          <a href={`https://wa.me/5491163692528?text=${encodeURIComponent(view.reference)}`} target="_blank" rel="noreferrer"
            className="mt-6 block text-center text-sm text-cab-400 hover:text-cab-500">{t("status.help")} →</a>
        )}
      </div>
    </div>
  );
}

function PayNow({ view, token, returned, locale }: { view: BookingStatusView; token: string; returned: boolean; locale: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const en = locale === "en";
  if (view.paymentMode !== "prepaid") return null;
  if (view.collectionState === "collected") {
    return <p className="mt-3 rounded-xl bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300" data-testid="paid">{en ? "✓ Paid" : "✓ Pagado"}</p>;
  }
  if (view.bookingState !== "held") return null;     // pay once a driver is reserved
  const ERR: Record<string, [string, string]> = {
    payments_not_configured: ["El pago online todavía no está disponible. Te contactamos por WhatsApp.", "Online payment isn't available yet. We'll contact you on WhatsApp."],
    fx_rate_missing: ["El pago online todavía no está disponible. Te contactamos por WhatsApp.", "Online payment isn't available yet. We'll contact you on WhatsApp."],
    already_paid: ["Este viaje ya está pagado.", "This trip is already paid."],
  };
  return (
    <div className="mt-3 rounded-xl border border-cab-500/40 bg-cab-500/10 p-4 text-sm" data-testid="pay-now">
      {returned ? (
        <p className="text-ink-200">{en ? "Checking your payment with Mercado Pago… this page updates by itself." : "Estamos verificando tu pago con Mercado Pago… esta página se actualiza sola."}</p>
      ) : (
        <p className="text-ink-200">{en ? "A driver is reserved for you. Pay now to confirm the trip." : "Tenés un chofer reservado. Pagá ahora para confirmar el viaje."}</p>
      )}
      <button disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { window.location.assign(await backend.payCheckout(view.reference, token)); }
        catch (e) { const c = (e as { code?: string }).code ?? "error"; setErr((ERR[c] ?? ["No pudimos abrir el pago. Probá de nuevo.", "We couldn't open the payment. Please try again."])[en ? 1 : 0]); setBusy(false); }
      }} className="mt-3 w-full rounded-xl bg-sky-500 px-4 py-3 font-semibold text-white hover:bg-sky-400 disabled:opacity-50">
        {busy ? "…" : en ? "Pay with Mercado Pago" : "Pagar con Mercado Pago"}
      </button>
      {err && <p className="mt-2 text-xs text-red-300" role="alert">{err}</p>}
    </div>
  );
}

type Done = { view: BookingStatusView; token: string; locale: string; onDone: () => void };
const statusPath = (ref: string, tail: string) => `/bookings/${encodeURIComponent(ref)}/${tail}`;

function CancelBox({ view, token, locale, onDone }: Done) {
  const en = locale === "en";
  const [terms, setTerms] = useState<CancelTerms | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const hdr = { "x-status-token": token };
  const money = (n: number, c: string | null) => (c ? formatMoney(n, c, locale) : String(n));
  const WHY: Record<string, [string, string]> = {
    driver_on_the_way: ["El chofer ya está en camino: escribinos por WhatsApp.", "The driver is already on the way: message us on WhatsApp."],
    trip_started: ["El viaje ya empezó.", "The trip has already started."],
  };
  const fail = (e: unknown) => { const c = (e as { code?: string }).code ?? "error"; setMsg((WHY[c] ?? ["No pudimos cancelar. Escribinos por WhatsApp.", "We couldn't cancel. Message us on WhatsApp."])[en ? 1 : 0]); setBusy(false); };

  if (!terms) {
    return (
      <button data-testid="cancel-open" disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        try { setTerms(await backend.api<CancelTerms>("GET", statusPath(view.reference, "cancel"), undefined, hdr)); setBusy(false); } catch (e) { fail(e); }
      }} className="mt-6 w-full rounded-xl border border-red-500/40 px-4 py-3 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">
        {busy ? "…" : en ? "Cancel this booking" : "Cancelar esta reserva"}
        {msg && <span className="mt-1 block text-xs" role="alert">{msg}</span>}
      </button>
    );
  }
  const refund = terms.paidMinor <= 0
    ? (en ? "There's no charge." : "Es sin cargo.")
    : terms.refundMinor > 0
      ? terms.refundPercent === 100 ? (en ? `We refund the full ${money(terms.refundMinor, terms.currency)}.` : `Te devolvemos el total: ${money(terms.refundMinor, terms.currency)}.`)
        : (en ? `Under the policy (less than ${terms.freeUntilHoursBefore} h before) we refund ${terms.refundPercent}%: ${money(terms.refundMinor, terms.currency)}.`
              : `Según la política (menos de ${terms.freeUntilHoursBefore} h antes) te devolvemos el ${terms.refundPercent}%: ${money(terms.refundMinor, terms.currency)}.`)
      : (en ? `Less than ${terms.freeUntilHoursBefore} h before pickup: no refund under the policy.` : `Faltan menos de ${terms.freeUntilHoursBefore} h: según la política no hay reembolso.`);
  return (
    <div className="mt-6 rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-sm" data-testid="cancel-box">
      {!terms.allowed ? <p className="text-red-300">{(WHY[terms.reason ?? ""] ?? ["No se puede cancelar online.", "It can't be cancelled online."])[en ? 1 : 0]}</p> : <>
        <p className="font-medium text-white">{en ? "Cancel this booking?" : "¿Cancelar esta reserva?"}</p>
        <p className="mt-1 text-ink-300">{refund}</p>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          placeholder={en ? "Reason (optional)" : "Motivo (opcional)"} className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm" />
        <div className="mt-3 flex gap-2">
          <button onClick={() => setTerms(null)} className="flex-1 rounded-lg border border-ink-600 px-3 py-2 text-ink-200">{en ? "Keep it" : "Mantener"}</button>
          <button data-testid="cancel-confirm" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await backend.api("POST", statusPath(view.reference, "cancel"), { reason }, hdr); onDone(); } catch (e) { fail(e); }
          }} className="flex-1 rounded-lg bg-red-500 px-3 py-2 font-semibold text-white hover:bg-red-400 disabled:opacity-50">{busy ? "…" : en ? "Yes, cancel" : "Sí, cancelar"}</button>
        </div>
        {msg && <p className="mt-2 text-xs text-red-300" role="alert">{msg}</p>}
      </>}
    </div>
  );
}

function RateBox({ view, token, locale, onDone }: Done) {
  const en = locale === "en";
  const [score, setScore] = useState<number>(view.rating ?? 0);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(!!view.rating);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  if (sent) return <p className="mt-6 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300" data-testid="rated">{"★".repeat(score)} {en ? "Thanks for your rating!" : "¡Gracias por tu calificación!"}</p>;
  return (
    <div className="mt-6 rounded-xl border border-ink-700 p-4 text-sm" data-testid="rate-box">
      <p className="font-medium text-white">{en ? "How was your trip?" : "¿Cómo estuvo tu viaje?"}</p>
      <div className="mt-2 flex gap-1" role="radiogroup">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={score === n} aria-label={`${n}`} onClick={() => setScore(n)}
            className={`text-3xl ${n <= score ? "text-cab-400" : "text-ink-600"}`}>★</button>
        ))}
      </div>
      {score > 0 && <>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={2}
          placeholder={score <= 2 ? (en ? "What went wrong?" : "¿Qué pasó?") : (en ? "Comment (optional)" : "Comentario (opcional)")}
          className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2" />
        <button data-testid="rate-send" disabled={busy} onClick={async () => {
          setBusy(true); setErr(false);
          try { await backend.api("POST", `/bookings/${encodeURIComponent(view.reference)}/rating`, { score, comment }, { "x-status-token": token }); setSent(true); onDone(); }
          catch { setErr(true); } finally { setBusy(false); }
        }} className="mt-2 w-full rounded-lg bg-cab-500 px-3 py-2 font-semibold text-ink-950 disabled:opacity-50">{busy ? "…" : en ? "Send" : "Enviar"}</button>
        {err && <p className="mt-2 text-xs text-red-300" role="alert">{en ? "Couldn't save. Try again." : "No se pudo guardar. Probá de nuevo."}</p>}
      </>}
    </div>
  );
}
