import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { BookingStatusView } from "@shared/api/store.ts";
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

  useEffect(() => {
    backend.api<BookingStatusView>("GET", `/bookings/${encodeURIComponent(ref)}`, undefined, { "x-status-token": sp.get("t") ?? "" })
      .then(setView).catch(() => setView("missing"));
  }, [ref, sp]);

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

        {view.direction === "from_airport" && (
          <div className="mt-4 rounded-xl border border-ink-700 p-4 text-sm">
            <div className="text-xs uppercase tracking-wide text-ink-400">{t("status.meeting")} · {view.airport} · {fmtTime(view.agreedPickupAt, locale)}</div>
            <p className="mt-1 text-ink-300">{locale === "en" ? view.meetingPoint.en : view.meetingPoint.es}</p>
          </div>
        )}

        {view.allowedActions.includes("contact_staff") && (
          <a href={`https://wa.me/5491163692528?text=${encodeURIComponent(view.reference)}`} target="_blank" rel="noreferrer"
            className="mt-6 block text-center text-sm text-cab-400 hover:text-cab-500">{t("status.help")} →</a>
        )}
      </div>
    </div>
  );
}
