// Airport timetable for drivers and dispatch: "Mis vuelos" (live status of the driver's own pickups) and
// arrivals/departures boards for Ezeiza and Aeroparque. Data comes from the `flights` function (shared cache).
import { useCallback, useEffect, useMemo, useState } from "react";
import { backend, type BoardFlight, type FlightBoard, type FlightStatus, type MyFlight } from "../lib/backend";
import { cx, fmtTime } from "../lib/format";

const STATUS: Record<FlightStatus, [string, string]> = {
  scheduled: ["Programado", "bg-ink-700 text-ink-200"], delayed: ["Demorado", "bg-amber-500/20 text-amber-300"],
  boarding: ["Embarcando", "bg-sky-500/20 text-sky-300"], departed: ["Despegó", "bg-sky-500/20 text-sky-300"],
  en_route: ["En vuelo", "bg-sky-500/20 text-sky-300"], approaching: ["Aproximando", "bg-emerald-500/20 text-emerald-300"],
  landed: ["Aterrizó", "bg-emerald-500 text-ink-950"], cancelled: ["Cancelado", "bg-red-500/20 text-red-300"],
  diverted: ["Desviado", "bg-red-500/20 text-red-300"], unknown: ["Sin datos", "bg-ink-800 text-ink-400"],
};
const ERR: Record<string, string> = {
  flights_not_configured: "Falta conectar el proveedor de vuelos (FLIGHTS_API_KEY). Mientras tanto se muestran solo los horarios programados de tus viajes.",
  provider_unavailable: "El proveedor de vuelos no responde; se muestran los últimos datos guardados.",
  flight_not_found: "El proveedor no encuentra este vuelo para esa fecha. Revisá el número con despacho.",
};

function Chip({ s }: { s: FlightStatus }) {
  const [label, cls] = STATUS[s] ?? STATUS.unknown;
  return <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", cls)}>{label}</span>;
}

/** Scheduled time, plus the new time when it moved (estimated or actual). */
function Times({ f }: { f: BoardFlight }) {
  const moved = f.actual ?? f.estimated;
  const late = moved ? Math.round((new Date(moved).getTime() - new Date(f.scheduled).getTime()) / 60000) : 0;
  return (
    <div className="w-16 shrink-0 tabular-nums">
      <div className={cx("text-lg font-bold leading-tight", moved && late !== 0 ? "text-ink-500 line-through decoration-1" : "text-white")}>{fmtTime(f.scheduled)}</div>
      {moved && late !== 0 && <div className={cx("text-sm font-bold", late > 0 ? "text-amber-300" : "text-emerald-300")}>{fmtTime(moved)}</div>}
    </div>
  );
}

export function FlightsPanel({ showMine = false, compact = false }: { showMine?: boolean; compact?: boolean }) {
  const [view, setView] = useState<"mine" | "arr" | "dep">(showMine ? "mine" : "arr");
  const [airport, setAirport] = useState<"EZE" | "AEP">("EZE");
  const [board, setBoard] = useState<FlightBoard | null>(null);
  const [mine, setMine] = useState<{ flights: MyFlight[]; configured: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      if (view === "mine") setMine(await backend.myFlights());
      else setBoard(await backend.flightBoard(airport, view));
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [view, airport]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const i = setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
    return () => clearInterval(i);
  }, [load]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (board?.flights ?? []).filter((f) => !t || `${f.number} ${f.number.replace(/\s/g, "")} ${f.airline} ${f.other.city} ${f.other.iata ?? ""}`.toLowerCase().includes(t));
  }, [board, q]);

  return (
    <div className={cx("space-y-3", !compact && "mx-auto max-w-3xl")} data-testid="flights">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-ink-900 p-1 text-sm" role="tablist">
          {([...(showMine ? [["mine", "Mis vuelos"]] : []), ["arr", "Llegadas"], ["dep", "Salidas"]] as [typeof view, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
              className={cx("rounded-md px-3 py-1.5 font-semibold", view === k ? "bg-ink-700 text-white" : "text-ink-400")}>{l}</button>
          ))}
        </div>
        {view !== "mine" && (
          <div className="flex rounded-lg bg-ink-900 p-1 text-sm">
            {(["EZE", "AEP"] as const).map((a) => (
              <button key={a} onClick={() => setAirport(a)} className={cx("rounded-md px-3 py-1.5 font-mono font-bold", airport === a ? "bg-cab-500 text-ink-950" : "text-ink-400")}>{a}</button>
            ))}
          </div>
        )}
        <button onClick={load} disabled={loading} className="ml-auto text-xs text-ink-400 hover:text-white disabled:opacity-50">{loading ? "Actualizando…" : "↻ Actualizar"}</button>
      </div>

      {err && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">No se pudieron cargar los vuelos ({err}).</p>}

      {view === "mine" && mine && (
        <div className="space-y-3">
          {!mine.configured && <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{ERR.flights_not_configured}</p>}
          {mine.flights.length === 0 && <p className="rounded-2xl border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-400">No tenés búsquedas en el aeropuerto en las próximas 30 horas.</p>}
          {mine.flights.map((m) => {
            const f = m.info;
            const landing = f ? (f.actual ?? f.estimated ?? f.scheduled) : null;
            return (
              <article key={m.reference} className="rounded-2xl border border-ink-700 bg-ink-900 p-4" data-testid={`my-flight-${m.reference}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-lg font-bold">{m.flight}</span>
                  {f && <Chip s={f.status} />}
                  <span className="ml-auto font-mono text-xs text-ink-400">{m.reference}</span>
                </div>
                {f ? (
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span className="text-ink-400">Desde</span><span>{f.other.city}{f.other.iata ? ` (${f.other.iata})` : ""} · {f.airline}</span>
                    <span className="text-ink-400">Aterrizaje programado</span><span className="tabular-nums">{fmtTime(f.scheduled)}</span>
                    <span className="text-ink-400">{f.actual ? "Aterrizó" : "Aterrizaje estimado"}</span>
                    <span className={cx("tabular-nums font-semibold", (m.shiftMinutes ?? 0) > 5 ? "text-amber-300" : (m.shiftMinutes ?? 0) < -5 ? "text-emerald-300" : "")}>
                      {landing ? fmtTime(landing) : "—"}{m.shiftMinutes ? ` (${m.shiftMinutes > 0 ? "+" : ""}${m.shiftMinutes} min)` : ""}
                    </span>
                    <span className="text-ink-400">Terminal · cinta</span><span>{f.terminal ?? "—"} · {f.belt ?? "—"}</span>
                    <span className="text-ink-400">Tu búsqueda</span><span className="tabular-nums font-semibold text-cab-400">{fmtTime(m.pickupAt)} en {m.airport}</span>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-ink-300">Búsqueda {fmtTime(m.pickupAt)} en {m.airport}. Vuelo del {m.flightDate}.</p>
                )}
                {m.error && <p className="mt-2 text-xs text-amber-200">{ERR[m.error] ?? m.error}</p>}
                {f?.status === "cancelled" || f?.status === "diverted" ? <p className="mt-2 text-xs font-semibold text-red-300">Avisá a despacho antes de salir.</p> : null}
              </article>
            );
          })}
        </div>
      )}

      {view !== "mine" && board && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar vuelo, ciudad o aerolínea" aria-label="Buscar vuelo"
            className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-ink-500" />
          {board.error && <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{ERR[board.error] ?? board.error}</p>}
          <ul className="divide-y divide-ink-800 rounded-2xl border border-ink-800 bg-ink-900" data-testid="flight-board">
            {rows.length === 0 && !board.error && <li className="px-4 py-8 text-center text-sm text-ink-400">Sin vuelos en este horario.</li>}
            {rows.map((f) => (
              <li key={`${f.number}-${f.scheduled}`} className="flex items-center gap-3 px-3 py-2.5">
                <Times f={f} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-white">{f.other.city || f.other.iata}{f.other.iata && f.other.city ? <span className="ml-1 text-xs text-ink-400">{f.other.iata}</span> : null}</div>
                  <div className="truncate text-xs text-ink-400">{f.number} · {f.airline}{f.terminal ? ` · T${f.terminal}` : ""}{f.belt ? ` · cinta ${f.belt}` : ""}{f.gate ? ` · puerta ${f.gate}` : ""}</div>
                </div>
                <Chip s={f.status} />
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-500">
            {board.airport === "EZE" ? "Ezeiza" : "Aeroparque"} · {view === "arr" ? "llegadas desde 1 h atrás" : "salidas"} · próximas 8 h
            {board.fetchedAt ? ` · datos de las ${fmtTime(board.fetchedAt)}` : ""}{board.stale ? " (sin actualizar)" : ""}
          </p>
        </>
      )}
    </div>
  );
}
