// Despacho → Informes: bookings, revenue, cancellations, ratings and drivers for a date range, with CSV export.
import { useEffect, useState } from "react";
import { addDaysLocal } from "@shared/domain/time.ts";
import { backend, type Report } from "../lib/backend";
import { cx, formatMoney } from "../lib/format";
import { Button, Input } from "./ui";

const SOURCE: Record<string, string> = { web: "Web", whatsapp: "WhatsApp", dispatcher: "Despacho", phone: "Teléfono", voice: "Sofía (voz)", api: "API" };
const STATE: Record<string, string> = { requested: "Solicitada", needs_driver: "Sin chofer", held: "Reservada", confirmed: "Confirmada", closed: "Finalizada", cancelled: "Cancelada" };
const todayBA = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const money = (list: { currency: string; amountMinor: number }[]) => (list.length ? list.map((x) => formatMoney(x.amountMinor, x.currency, "es-AR")).join(" + ") : "—");

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-ink-800 p-4">
      <div className="text-xs uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-white">{value}</div>
      {sub && <div className="text-xs text-ink-500">{sub}</div>}
    </div>
  );
}

function Bars({ title, data, labels = {} }: { title: string; data: Record<string, number>; labels?: Record<string, string> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="rounded-xl border border-ink-800 p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-ink-400">{title}</div>
      {entries.length ? entries.map(([k, v]) => (
        <div key={k} className="mb-1.5 grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-sm">
          <span className="truncate text-ink-300">{labels[k] ?? k}</span>
          <span className="h-2.5 rounded-full bg-ink-800"><span className="block h-full rounded-full bg-cab-500" style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="text-right tabular-nums text-ink-200">{v}</span>
        </div>
      )) : <p className="text-sm text-ink-500">Sin datos.</p>}
    </div>
  );
}

function Daily({ daily }: { daily: Report["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.bookings));
  return (
    <div className="rounded-xl border border-ink-800 p-4">
      <div className="mb-2 flex justify-between text-xs uppercase tracking-wide text-ink-400"><span>Reservas por día (fecha del viaje)</span><span>máx. {max}</span></div>
      <div className="flex h-32 items-end gap-px" role="img" aria-label="Reservas por día">
        {daily.map((d) => (
          <div key={d.day} title={`${d.day}: ${d.bookings} reservas, ${d.completed} finalizadas`} className="flex h-full flex-1 flex-col justify-end">
            <div className="rounded-t bg-cab-500/80" style={{ height: `${(d.bookings / max) * 100}%`, minHeight: d.bookings ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-500"><span>{daily[0]?.day}</span><span>{daily[daily.length - 1]?.day}</span></div>
    </div>
  );
}

function download(r: Report) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows: unknown[][] = [["Informe SoyTuTaxi", `${r.from} a ${r.to}`], [],
    ["Reservas", r.bookings], ["Finalizadas", r.completed], ["Canceladas", r.cancelled], ["Canceladas por el pasajero", r.cancelledByPassenger],
    ...r.revenue.map((x) => [`Facturación ${x.currency}`, (x.amountMinor / 100).toFixed(2)]),
    ...r.driverCost.map((x) => [`Pago a choferes ${x.currency}`, (x.amountMinor / 100).toFixed(2)]),
    ...r.refunds.map((x) => [`Reembolsos ${x.currency}`, (x.amountMinor / 100).toFixed(2)]),
    ["Calificación promedio", r.ratings.average ?? ""], ["Calificaciones", r.ratings.count], [],
    ["Día", "Reservas", "Finalizadas"], ...r.daily.map((d) => [d.day, d.bookings, d.completed]), [],
    ["Chofer", "Viajes", "Ganancia", "Moneda", "Calificación", "No-shows"],
    ...r.drivers.map((d) => [d.fullName, d.trips, (d.earningsMinor / 100).toFixed(2), d.currency, d.rating ?? "", d.noShows])];
  const blob = new Blob(["﻿" + rows.map((x) => x.map(esc).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `informe-soytutaxi-${r.from}-${r.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ReportsPanel() {
  const t = todayBA();
  const [from, setFrom] = useState(addDaysLocal(t, -23));
  const [to, setTo] = useState(addDaysLocal(t, 7));
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    backend.report(from, to).then(setR, (e) => setErr((e as { code?: string }).code === "forbidden" ? "No tenés permiso para ver informes." : String((e as Error).message)));
  }, [from, to]);
  const preset = (days: number, offset = 0) => { setTo(addDaysLocal(t, offset)); setFrom(addDaysLocal(t, offset - days + 1)); };

  return (
    <div data-testid="reports">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-400">Desde<Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="mt-1 py-2" /></label>
        <label className="text-xs text-ink-400">Hasta<Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="mt-1 py-2" /></label>
        <Button variant="ghost" className="py-2" onClick={() => preset(7)}>7 días</Button>
        <Button variant="ghost" className="py-2" onClick={() => preset(30)}>30 días</Button>
        <Button variant="ghost" className="py-2" onClick={() => preset(14, 14)}>Próximas 2 semanas</Button>
        {r && <Button variant="outline" className="ml-auto py-2" onClick={() => download(r)}>Descargar CSV</Button>}
      </div>
      {err && <p className="text-sm text-red-300">{err}</p>}
      {r && (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Reservas" value={r.bookings} sub={`${r.completed} finalizadas`} />
            <Stat label="Facturación" value={money(r.revenue)} sub="viajes finalizados" />
            <Stat label="Pago a choferes" value={money(r.driverCost)} />
            <Stat label="Cancelaciones" value={r.cancelled} sub={`${r.cancelledByPassenger} por el pasajero · reembolsos ${money(r.refunds)}`} />
            <Stat label="Calificación" value={r.ratings.average != null ? `${r.ratings.average} ★` : "—"} sub={`${r.ratings.count} calificaciones · ${r.ratings.low} bajas`} />
            <Stat label="Conversión" value={r.bookings ? `${Math.round((r.completed / r.bookings) * 100)}%` : "—"} sub="finalizadas / reservas" />
          </div>
          <Daily daily={r.daily} />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Bars title="Por canal" data={r.bySource} labels={SOURCE} />
            <Bars title="Por estado" data={r.byState} labels={STATE} />
            <Bars title="Por aeropuerto" data={r.byAirport} />
            <Bars title="Zonas principales" data={Object.fromEntries(r.topZones.map((z) => [z.zone, z.bookings]))} />
          </div>
          <div className="overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full text-sm">
              <thead className="bg-ink-900 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr><th className="px-3 py-2">Chofer</th><th className="px-3 py-2 text-right">Viajes</th><th className="px-3 py-2 text-right">Ganancia</th><th className="px-3 py-2 text-right">Calificación</th><th className="px-3 py-2 text-right">No-shows</th></tr>
              </thead>
              <tbody>
                {r.drivers.map((d) => (
                  <tr key={d.driverId} className="border-t border-ink-800">
                    <td className="px-3 py-2 text-white">{d.fullName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.trips}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.currency ? formatMoney(d.earningsMinor, d.currency, "es-AR") : "—"}</td>
                    <td className={cx("px-3 py-2 text-right tabular-nums", d.rating != null && d.rating < 3.5 && "text-amber-300")}>{d.rating != null ? `${d.rating} ★ (${d.ratings})` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.noShows}</td>
                  </tr>
                ))}
                {!r.drivers.length && <tr><td colSpan={5} className="px-3 py-3 text-ink-500">Sin viajes finalizados en el período.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
