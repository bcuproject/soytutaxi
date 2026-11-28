import { Badge } from "./ui";
import type { DispatchRow, PastCall, WaCall } from "../lib/backend";
import { fmtDateTime } from "../lib/format";

const STATE: Record<string, string> = {
  requested: "Solicitada", needs_driver: "Sin chofer", held: "Hold", confirmed: "Confirmada", closed: "Cerrada", cancelled: "Cancelada",
};

export type CallerHistoryData = { call: Pick<WaCall, "id" | "name" | "phone">; rows: DispatchRow[]; calls?: PastCall[] };

/** A caller's bookings and earlier calls (with Sofía's transcripts). */
export function CallerHistory({ h, onClose }: { h: CallerHistoryData; onClose?: () => void }) {
  const past = (h.calls ?? []).filter((c) => c.id !== h.call.id);
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900 p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-semibold">Historial de {h.call.name || h.call.phone}</h3>
        {onClose && <button className="ml-auto text-sm text-ink-400 hover:text-white" onClick={onClose}>Cerrar</button>}
      </div>
      {h.rows.length === 0 ? <p className="text-sm text-ink-400">Cliente nuevo: no tiene reservas con este número.</p> : (
        <ul className="divide-y divide-ink-800 text-sm">
          {h.rows.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-3 py-1.5">
              <span className="font-mono font-semibold">{r.reference}</span>
              <span className="tabular-nums text-ink-300">{fmtDateTime(r.agreedPickupAt)}</span>
              <span>{r.direction === "from_airport" ? `${r.airport} → ${r.zoneName ?? ""}` : `${r.zoneName ?? ""} → ${r.airport}`}</span>
              <Badge tone={r.state}>{STATE[r.state] ?? r.state}</Badge>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <div className="mt-3 border-t border-ink-800 pt-3" data-testid="past-calls">
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">Llamadas anteriores</div>
          {past.map((c) => (
            <details key={c.id} className="border-b border-ink-800 py-1.5 text-sm last:border-0">
              <summary className="cursor-pointer">
                <span className="tabular-nums text-ink-300">{fmtDateTime(c.startedAt)}</span>
                {" · "}{c.handledBy === "bot" ? (c.transferred ? "Sofía → Central" : "Sofía") : "Central"}
                {c.durationS ? ` · ${Math.max(1, Math.round(c.durationS / 60))} min` : ""}
                {c.bookingRef && <span className="font-mono"> · {c.bookingRef}</span>}
                {c.note && <span className="text-cab-300"> · {c.note}</span>}
              </summary>
              {c.transcript ? <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-2 text-xs text-ink-300">{c.transcript}</pre>
                : <p className="mt-1 text-xs text-ink-500">Sin transcripción.</p>}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
