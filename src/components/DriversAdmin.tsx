// Despacho → Choferes: required documents with expiry (and the blocking switch), and driver pay:
// unsettled balance per driver, statement lines, adjustments, settlement and CSV export.
import { useCallback, useEffect, useState } from "react";
import { backend, type Compliance, type DocKind, type DriverDoc, type FinanceRow, type MoneyTotal, type Statement } from "../lib/backend";
import { cx, fmtDateShort, formatMoney } from "../lib/format";
import { Button, Input } from "./ui";

export const DOC_LABEL: Record<DocKind, string> = {
  license: "Licencia de conducir", professional_license: "Licencia profesional", insurance: "Seguro",
  vtv: "VTV", permit: "Habilitación remis", other: "Otro",
};
const REQUIRED: { owner: DriverDoc["owner"]; kind: DocKind }[] = [
  { owner: "driver", kind: "license" }, { owner: "driver", kind: "professional_license" },
  { owner: "vehicle", kind: "insurance" }, { owner: "vehicle", kind: "vtv" }, { owner: "vehicle", kind: "permit" },
];
const STATUS_CLS = { ok: "bg-emerald-500/15 text-emerald-300", expiring: "bg-amber-500/20 text-amber-300", expired: "bg-red-500/20 text-red-300", missing: "bg-ink-800 text-ink-400" };
const errText = (e: unknown) => {
  const c = (e as { code?: string; message?: string }).code ?? (e as Error).message;
  return ({ forbidden: "No tenés permiso para esto (requiere rol admin/finanzas).", live_only: "Disponible solo en modo en vivo.",
    nothing_to_settle: "No hay movimientos pendientes para liquidar.", reason_required: "Escribí el motivo.", invalid_amount: "Monto inválido." } as Record<string, string>)[c] ?? c;
};
const money = (n: number, c: string) => formatMoney(n, c, "es-AR");

export function DriversAdmin() {
  const [view, setView] = useState<"docs" | "pay">("docs");
  return (
    <div data-testid="drivers-admin">
      <div className="mb-4 flex gap-1 rounded-lg bg-ink-900 p-1 text-sm" role="tablist">
        {([["docs", "Documentación"], ["pay", "Pagos y liquidaciones"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
            className={cx("rounded-md px-3 py-1.5 font-medium", view === k ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white")}>{l}</button>
        ))}
      </div>
      {view === "docs" ? <Documents /> : <Pay />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ documents
function Documents() {
  const [c, setC] = useState<Compliance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ driverId: string; vehicleId: string | null; owner: DriverDoc["owner"]; kind: DocKind; doc?: DriverDoc } | null>(null);
  const load = useCallback(() => backend.compliance().then(setC, (e) => setErr(errText(e))), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <p className="text-sm text-red-300">{err}</p>;
  if (!c) return <p className="text-sm text-ink-400">Cargando…</p>;
  const blocked = c.drivers.filter((d) => d.active && d.problem).length;

  return (
    <div>
      <div className={cx("mb-4 flex flex-wrap items-center gap-4 rounded-xl border p-4 text-sm", c.enforce ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
        <div className="flex-1">
          <div className="font-semibold text-white">{c.enforce ? "Bloqueo activo" : "Solo avisos"}</div>
          <p className="text-ink-300">{c.enforce
            ? "Un chofer con documentación faltante o vencida (a la fecha del viaje) no puede recibir ni aceptar viajes."
            : "Se avisa cuando falta o vence un documento, pero no se bloquea la asignación. Activá el bloqueo cuando hayas cargado los documentos."}
            {" "}Aviso con {c.warnDays} días de anticipación.</p>
          {blocked > 0 && <p className="mt-1 text-amber-300">{blocked} chofer(es) con documentación incompleta{c.enforce ? " — bloqueados" : ""}.</p>}
        </div>
        <Button variant={c.enforce ? "outline" : "primary"} data-testid="toggle-enforce" onClick={async () => {
          try { await backend.setCompliance(!c.enforce, c.warnDays); load(); } catch (e) { setErr(errText(e)); }
        }}>{c.enforce ? "Pasar a solo avisos" : "Activar bloqueo"}</Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr><th className="px-3 py-2">Chofer · vehículo</th>{REQUIRED.map((r) => <th key={r.kind} className="px-3 py-2">{DOC_LABEL[r.kind]}</th>)}</tr>
          </thead>
          <tbody>
            {c.drivers.map((d) => (
              <tr key={d.id} className="border-t border-ink-800" data-testid="doc-row">
                <td className="px-3 py-2">
                  <div className="font-medium text-white">{d.fullName}</div>
                  <div className="text-xs text-ink-400">{d.vehicle ? `${d.vehicle.plate} · ${d.vehicle.description ?? ""}` : "Sin vehículo asignado"}</div>
                </td>
                {REQUIRED.map((r) => {
                  const doc = d.documents.find((x) => x.owner === r.owner && x.kind === r.kind);
                  const st = doc ? doc.status : "missing";
                  const disabled = r.owner === "vehicle" && !d.vehicle;
                  return (
                    <td key={r.kind} className="px-3 py-2">
                      <button disabled={disabled} onClick={() => setEdit({ driverId: d.id, vehicleId: d.vehicle?.id ?? null, owner: r.owner, kind: r.kind, doc })}
                        className={cx("rounded-md px-2 py-1 text-xs font-semibold disabled:opacity-40", STATUS_CLS[st])}>
                        {doc ? `${st === "expired" ? "Venció " : "Vence "}${doc.expiresOn.split("-").reverse().join("/")}` : "Falta"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <DocForm e={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function DocForm({ e, onClose, onSaved }: { e: { driverId: string; vehicleId: string | null; owner: DriverDoc["owner"]; kind: DocKind; doc?: DriverDoc }; onClose: () => void; onSaved: () => void }) {
  const [expiresOn, setExpires] = useState(e.doc?.expiresOn ?? "");
  const [number, setNumber] = useState(e.doc?.number ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-5" onClick={(x) => x.stopPropagation()} data-testid="doc-form"
        onSubmit={async (x) => {
          x.preventDefault();
          if (!expiresOn) { setErr("Indicá el vencimiento."); return; }
          try {
            await backend.setDocument({ id: e.doc?.id ?? null, driverId: e.owner === "driver" ? e.driverId : null, vehicleId: e.owner === "vehicle" ? e.vehicleId : null,
              kind: e.kind, number, expiresOn });
            onSaved();
          } catch (y) { setErr(errText(y)); }
        }}>
        <h3 className="font-semibold text-white">{DOC_LABEL[e.kind]}</h3>
        <label className="mt-3 block text-xs text-ink-400">Número (opcional)<Input value={number} onChange={(x) => setNumber(x.target.value)} maxLength={60} className="mt-1 py-2" /></label>
        <label className="mt-3 block text-xs text-ink-400">Vence el<Input type="date" value={expiresOn} onChange={(x) => setExpires(x.target.value)} className="mt-1 py-2" aria-label="Vencimiento" /></label>
        {err && <p className="mt-2 text-xs text-red-300" role="alert">{err}</p>}
        <div className="mt-4 flex gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button><Button type="submit" className="flex-1">Guardar</Button></div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ pay
function Totals({ t }: { t: MoneyTotal[] }) {
  if (!t.length) return <span className="text-ink-500">Sin pendientes</span>;
  return <>{t.map((x) => (
    <span key={x.currency} className={cx("font-semibold tabular-nums", x.netMinor >= 0 ? "text-emerald-300" : "text-amber-300")}>
      {x.netMinor >= 0 ? `A pagar ${money(x.netMinor, x.currency)}` : `Debe rendir ${money(-x.netMinor, x.currency)}`}
    </span>
  ))}</>;
}

function csv(st: Statement) {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["Fecha", "Tipo", "Reserva", "Ganancia", "Efectivo cobrado", "Moneda", "Nota"],
    ...st.lines.map((l) => [l.at.slice(0, 16).replace("T", " "), l.kind === "trip" ? "Viaje" : l.kind === "cash" ? "Efectivo" : "Ajuste", l.reference ?? "",
      (l.earningMinor / 100).toFixed(2), (l.cashMinor / 100).toFixed(2), l.currency, l.note]),
    ...st.totals.map((t) => ["Total", "", "", (t.earningsMinor / 100).toFixed(2), (t.cashMinor / 100).toFixed(2), t.currency, `Neto ${(t.netMinor / 100).toFixed(2)}`])];
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `liquidacion-${st.driver.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Pay() {
  const [rows, setRows] = useState<FinanceRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => backend.financeOverview().then(setRows, (e) => setErr(errText(e))), []);
  useEffect(() => { load(); }, [load]);
  if (err) return <p className="text-sm text-red-300">{err}</p>;
  if (!rows) return <p className="text-sm text-ink-400">Cargando…</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div className="rounded-xl border border-ink-800">
        <p className="border-b border-ink-800 px-4 py-2 text-xs text-ink-400">Neto = ganancias de viajes y ajustes − efectivo cobrado a pasajeros.</p>
        {rows.map((r) => (
          <button key={r.driverId} onClick={() => setOpen(r.driverId)} data-testid="pay-row"
            className={cx("flex w-full items-center justify-between gap-3 border-b border-ink-800 px-4 py-3 text-left text-sm last:border-0 hover:bg-ink-900", open === r.driverId && "bg-ink-900")}>
            <span><span className="font-medium text-white">{r.fullName}</span>
              {r.lastSettlement && <span className="block text-xs text-ink-500">Última liquidación {fmtDateShort(r.lastSettlement.at)}</span>}</span>
            <span className="text-right"><Totals t={r.totals} /></span>
          </button>
        ))}
      </div>
      {open && <StatementPanel driverId={open} onChanged={load} key={open} />}
    </div>
  );
}

function StatementPanel({ driverId, onChanged }: { driverId: string; onChanged: () => void }) {
  const [st, setSt] = useState<Statement | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [adj, setAdj] = useState({ amount: "", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => backend.financeStatement(driverId, batch).then(setSt, (e) => setMsg(errText(e))), [driverId, batch]);
  useEffect(() => { load(); }, [load]);
  if (!st) return <div className="text-sm text-ink-400">{msg ?? "Cargando…"}</div>;
  const cur = st.totals[0]?.currency ?? st.lines[0]?.currency ?? "ARS";
  return (
    <div className="rounded-xl border border-ink-800 p-4 text-sm" data-testid="statement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-white">{st.driver} · {batch ? "Liquidación cerrada" : "Pendiente de liquidar"}</h3>
        <div className="flex gap-2">
          {batch && <Button variant="ghost" className="py-1.5" onClick={() => setBatch(null)}>← Pendiente</Button>}
          <Button variant="outline" className="py-1.5" disabled={!st.lines.length} onClick={() => csv(st)}>Descargar CSV</Button>
        </div>
      </div>
      <table className="mt-3 w-full">
        <thead className="text-left text-xs text-ink-400"><tr><th className="py-1">Fecha</th><th>Concepto</th><th className="text-right">Ganancia</th><th className="text-right">Efectivo</th></tr></thead>
        <tbody>
          {st.lines.map((l, i) => (
            <tr key={i} className="border-t border-ink-800">
              <td className="py-1.5 text-ink-400">{fmtDateShort(l.at)}</td>
              <td>{l.kind === "trip" ? `Viaje ${l.reference}` : l.kind === "cash" ? `Efectivo cobrado ${l.reference}` : `Ajuste: ${l.note}`}</td>
              <td className="text-right tabular-nums">{l.earningMinor ? money(l.earningMinor, l.currency) : ""}</td>
              <td className="text-right tabular-nums text-amber-300">{l.cashMinor ? money(l.cashMinor, l.currency) : ""}</td>
            </tr>
          ))}
          {!st.lines.length && <tr><td colSpan={4} className="py-3 text-ink-500">Sin movimientos.</td></tr>}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end"><Totals t={st.totals} /></div>

      {!batch && <>
        <form className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-800 pt-4" onSubmit={async (e) => {
          e.preventDefault(); setMsg(null);
          const n = Math.round(Number(adj.amount.replace(",", ".")) * 100);
          try { await backend.financeAdjust(driverId, n, cur, adj.note); setAdj({ amount: "", note: "" }); load(); onChanged(); } catch (x) { setMsg(errText(x)); }
        }}>
          <label className="text-xs text-ink-400">Ajuste ({cur}, negativo descuenta)<Input value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} className="mt-1 w-36 py-2" inputMode="decimal" /></label>
          <label className="flex-1 text-xs text-ink-400">Motivo<Input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} maxLength={300} className="mt-1 py-2" /></label>
          <Button variant="outline" className="py-2" type="submit">Agregar ajuste</Button>
        </form>
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-800 pt-4">
          <label className="flex-1 text-xs text-ink-400">Referencia del pago o rendición (opcional)<Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="mt-1 py-2" placeholder="Ej.: Transferencia 28/11" /></label>
          <Button className="py-2" data-testid="settle" disabled={!st.lines.length} onClick={async () => {
            setMsg(null);
            try { await backend.financeSettle(driverId, note); setNote(""); load(); onChanged(); setMsg("Liquidación cerrada ✓"); } catch (x) { setMsg(errText(x)); }
          }}>Cerrar liquidación</Button>
        </div>
        <p className="mt-1 text-xs text-ink-500">Cierra todos los movimientos pendientes hasta ahora. Registrá el pago o la rendición de efectivo fuera del sistema.</p>
      </>}
      {msg && <p className="mt-2 text-xs text-ink-200" role="status">{msg}</p>}

      {st.batches.length > 0 && (
        <div className="mt-4 border-t border-ink-800 pt-3">
          <div className="text-xs uppercase tracking-wide text-ink-400">Liquidaciones anteriores</div>
          {st.batches.map((b) => (
            <button key={b.id} onClick={() => setBatch(b.id)} className="flex w-full justify-between py-1.5 text-left hover:text-white">
              <span>{fmtDateShort(b.at)} · {b.trips} viaje(s){b.note ? ` · ${b.note}` : ""}</span>
              <span className="tabular-nums">{money(b.netMinor, b.currency)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
