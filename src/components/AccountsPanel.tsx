// Despacho → Cuentas: hotels and agencies whose trips are billed monthly. Account details, unbilled trips,
// invoices (draft → issued → paid, or void) and a printable statement for each invoice.
import { useCallback, useEffect, useState } from "react";
import { backend, type Account, type AccountInvoice, type InvoiceDoc } from "../lib/backend";
import { cx, formatMoney } from "../lib/format";
import { Button, Input, Select } from "./ui";

const KIND: Record<Account["kind"], string> = { hotel: "Hotel", agency: "Agencia", company: "Empresa" };
const STATE: Record<AccountInvoice["state"], [string, string]> = {
  draft: ["Borrador", "bg-ink-700 text-ink-200"], issued: ["Emitida", "bg-sky-500/20 text-sky-300"],
  paid: ["Cobrada", "bg-emerald-500/15 text-emerald-300"], void: ["Anulada", "bg-ink-800 text-ink-500 line-through"],
};
const ERR: Record<string, string> = {
  forbidden: "Tu usuario no tiene permiso (requiere admin o finanzas).", nothing_to_invoice: "No hay viajes finalizados sin facturar en ese mes.",
  account_exists: "Ya existe una cuenta con ese nombre.", name_required: "Indicá el nombre.", invalid_transition: "Esa factura ya cambió de estado.",
  live_only: "Disponible solo en modo en vivo.",
};
const errText = (e: unknown) => ERR[(e as { code?: string }).code ?? ""] ?? (e as Error).message;
const money = (list: { currency: string; amountMinor: number }[]) => (list.length ? list.map((x) => formatMoney(x.amountMinor, x.currency, "es-AR")).join(" + ") : "—");
const dmy = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "—");
const lastMonth = () => {
  const t = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const [y, m] = t.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export function AccountsPanel() {
  const [list, setList] = useState<Account[] | null>(null);
  const [sel, setSel] = useState<string | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => backend.accounts().then(setList, (e) => setErr(errText(e))), []);
  useEffect(() => { load(); }, [load]);
  if (err && !list) return <p className="text-sm text-red-300">{err}</p>;
  if (!list) return <p className="text-sm text-ink-400">Cargando…</p>;
  const current = list.find((a) => a.id === sel);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]" data-testid="accounts">
      <div className="rounded-xl border border-ink-800">
        <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2">
          <p className="text-xs text-ink-400">Los viajes a cuenta no se cobran al pasajero: se facturan a fin de mes.</p>
          <Button className="py-1.5 text-sm" onClick={() => setSel("new")}>+ Nueva cuenta</Button>
        </div>
        {list.map((a) => (
          <button key={a.id} onClick={() => setSel(a.id)} data-testid="account-row"
            className={cx("flex w-full items-center justify-between gap-3 border-b border-ink-800 px-4 py-3 text-left text-sm last:border-0 hover:bg-ink-900", sel === a.id && "bg-ink-900", !a.active && "opacity-50")}>
            <span><span className="font-medium text-white">{a.name}</span>
              <span className="block text-xs text-ink-500">{KIND[a.kind]}{a.discountPercent > 0 && ` · ${a.discountPercent}% desc.`} · pago a {a.paymentTermsDays} días{a.upcoming > 0 && ` · ${a.upcoming} viaje(s) próximos`}</span></span>
            <span className="text-right text-xs">
              <span className="block text-ink-300">Sin facturar: <b className="text-white">{money(a.unbilled)}</b></span>
              {a.outstanding.length > 0 && <span className={cx("block", a.invoices.some((i) => i.overdue) ? "text-red-300" : "text-amber-300")}>A cobrar: {money(a.outstanding)}</span>}
            </span>
          </button>
        ))}
        {!list.length && <p className="px-4 py-6 text-sm text-ink-500">Todavía no hay cuentas. Creá la primera para un hotel o agencia.</p>}
      </div>
      {sel === "new" && <AccountForm key="new" onSaved={(id) => { load(); setSel(id); }} onCancel={() => setSel(null)} />}
      {current && <AccountDetail key={current.id} a={current} reload={load} />}
    </div>
  );
}

function AccountForm({ a, onSaved, onCancel }: { a?: Account; onSaved: (id: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: a?.name ?? "", kind: a?.kind ?? "hotel", taxId: a?.taxId ?? "", email: a?.email ?? "", phone: a?.phone ?? "",
    address: a?.address ?? "", discountPercent: String(a?.discountPercent ?? 0), paymentTermsDays: String(a?.paymentTermsDays ?? 30), active: a?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const field = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <label className="text-xs text-ink-400">{label}<Input value={String(f[k])} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="mt-1 py-2" {...props} /></label>
  );
  return (
    <form className="rounded-xl border border-ink-800 p-4" data-testid="account-form" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      try {
        onSaved(await backend.saveAccount({ id: a?.id, name: f.name, kind: f.kind as Account["kind"], taxId: f.taxId, email: f.email, phone: f.phone, address: f.address,
          discountPercent: Number(f.discountPercent) || 0, paymentTermsDays: Number(f.paymentTermsDays) || 0, active: f.active }));
      } catch (x) { setErr(errText(x)); }
    }}>
      <h3 className="mb-3 font-semibold text-white">{a ? "Editar cuenta" : "Nueva cuenta"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("name", "Nombre", { "aria-label": "Nombre de la cuenta", maxLength: 120 })}
        <label className="text-xs text-ink-400">Tipo<Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Account["kind"] })} className="mt-1 py-2">
          {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        {field("taxId", "CUIT", { maxLength: 20 })}
        {field("email", "E-mail de facturación", { type: "email", maxLength: 200 })}
        {field("phone", "Teléfono", { maxLength: 30 })}
        {field("address", "Dirección", { maxLength: 200 })}
        {field("discountPercent", "Descuento (%)", { inputMode: "decimal" })}
        {field("paymentTermsDays", "Plazo de pago (días)", { inputMode: "numeric" })}
      </div>
      {a && <label className="mt-3 flex items-center gap-2 text-sm text-ink-300"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Cuenta activa</label>}
      {err && <p className="mt-2 text-xs text-red-300" role="alert">{err}</p>}
      <div className="mt-4 flex gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button><Button type="submit">Guardar</Button></div>
    </form>
  );
}

function AccountDetail({ a, reload }: { a: Account; reload: () => void }) {
  const [edit, setEdit] = useState(false);
  const [month, setMonth] = useState(lastMonth());
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try { await fn(); reload(); if (ok) setMsg(ok); } catch (e) { setMsg(errText(e)); }
  };
  if (edit) return <AccountForm a={a} onSaved={() => { setEdit(false); reload(); }} onCancel={() => setEdit(false)} />;
  return (
    <div className="rounded-xl border border-ink-800 p-4 text-sm" data-testid="account-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold text-white">{a.name}</h3>
          <p className="text-xs text-ink-400">{KIND[a.kind]}{a.taxId && ` · CUIT ${a.taxId}`}{a.email && ` · ${a.email}`}</p>
        </div>
        <Button variant="outline" className="py-1.5" onClick={() => setEdit(true)}>Editar</Button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-ink-900 p-3"><div className="text-xs text-ink-400">Sin facturar</div><div className="font-semibold text-white">{money(a.unbilled)}</div>
          <div className="text-xs text-ink-500">{a.unbilled.reduce((n, u) => n + u.trips, 0)} viaje(s) finalizados</div></div>
        <div className="rounded-lg bg-ink-900 p-3"><div className="text-xs text-ink-400">Facturado a cobrar</div><div className="font-semibold text-white">{money(a.outstanding)}</div></div>
        <div className="rounded-lg bg-ink-900 p-3"><div className="text-xs text-ink-400">Condiciones</div><div className="text-white">{a.discountPercent}% desc. · {a.paymentTermsDays} días</div></div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-ink-800 pt-4">
        <label className="text-xs text-ink-400">Mes<Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="mt-1 py-2" aria-label="Mes a facturar" /></label>
        <Button className="py-2" data-testid="generate-invoice" onClick={() => run(() => backend.generateInvoice(a.id, `${month}-01`), "Factura en borrador creada ✓")}>Generar factura del mes</Button>
        <p className="w-full text-xs text-ink-500">El día 1 de cada mes se generan solas las facturas en borrador del mes anterior. Revisalas y emitilas.</p>
      </div>
      {msg && <p className="mt-2 text-xs text-ink-200" role="status">{msg}</p>}
      <table className="mt-4 w-full">
        <thead className="text-left text-xs text-ink-400"><tr><th className="py-1">Número</th><th>Período</th><th className="text-right">Total</th><th className="pl-3">Estado</th><th /></tr></thead>
        <tbody>
          {a.invoices.map((i) => (
            <tr key={i.id} className="border-t border-ink-800" data-testid="invoice-row">
              <td className="py-2 font-mono text-xs">{i.number}</td>
              <td className="text-xs text-ink-300">{dmy(i.periodStart)} – {dmy(i.periodEnd)}</td>
              <td className="text-right tabular-nums">{formatMoney(i.totalMinor, i.currency, "es-AR")}</td>
              <td className="pl-3"><span className={cx("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATE[i.state][1])}>{STATE[i.state][0]}</span>
                {i.state === "issued" && <span className={cx("ml-1 text-[11px]", i.overdue ? "text-red-300" : "text-ink-500")}>{i.overdue ? "vencida" : "vence"} {dmy(i.dueOn)}</span>}</td>
              <td className="space-x-1 whitespace-nowrap text-right">
                <button className="text-xs text-cab-400 hover:underline" onClick={() => run(async () => printInvoice(await backend.invoice(i.id)))}>Ver / imprimir</button>
                {i.state === "draft" && <button className="text-xs text-sky-300 hover:underline" onClick={() => run(() => backend.setInvoiceState(i.id, "issued"), "Factura emitida ✓")}>Emitir</button>}
                {i.state === "issued" && <button className="text-xs text-emerald-300 hover:underline" onClick={() => run(() => backend.setInvoiceState(i.id, "paid"), "Marcada como cobrada ✓")}>Cobrada</button>}
                {(i.state === "draft" || i.state === "issued") && <button className="text-xs text-ink-400 hover:underline" onClick={() => run(() => backend.setInvoiceState(i.id, "void"), "Factura anulada; sus viajes vuelven a quedar sin facturar.")}>Anular</button>}
              </td>
            </tr>
          ))}
          {!a.invoices.length && <tr><td colSpan={5} className="py-3 text-ink-500">Sin facturas todavía.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Opens a printable statement in a new window (the browser's print dialog can save it as PDF). */
function printInvoice(d: InvoiceDoc) {
  const m = (n: number) => formatMoney(n, d.currency, "es-AR");
  const esc = (s: string | null) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const when = (iso: string) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(d.number)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:40px;max-width:800px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:20px}
th,td{padding:6px 4px;border-bottom:1px solid #ddd;text-align:left}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.muted{color:#666}.tot td{border:0;font-weight:600}
.head{display:flex;justify-content:space-between;gap:24px}.box{border:1px solid #ddd;border-radius:8px;padding:10px 14px}.note{margin-top:28px;font-size:11px;color:#666}</style></head><body>
<div class="head"><div><h1>${esc(d.operator)}</h1><div class="muted">Resumen de cuenta de traslados</div></div>
<div class="box"><b>${esc(d.number)}</b><br>Período: ${dmy(d.periodStart)} – ${dmy(d.periodEnd)}<br>${d.issuedAt ? `Emitida: ${dmy(d.issuedAt)}<br>` : "<i>Borrador</i><br>"}${d.dueOn ? `Vence: ${dmy(d.dueOn)}` : ""}</div></div>
<p><b>${esc(d.account.name)}</b>${d.account.taxId ? ` · CUIT ${esc(d.account.taxId)}` : ""}<br><span class="muted">${esc(d.account.address)}${d.account.email ? ` · ${esc(d.account.email)}` : ""}</span></p>
<table><thead><tr><th>Fecha</th><th>Reserva</th><th>Detalle</th><th class="n">Importe</th></tr></thead><tbody>
${d.lines.map((l) => `<tr><td>${when(l.pickupAt)}</td><td>${esc(l.reference)}</td><td>${esc(l.description)}</td><td class="n">${m(l.amountMinor)}</td></tr>`).join("")}
</tbody><tbody><tr class="tot"><td colspan="3" class="n">Subtotal</td><td class="n">${m(d.subtotalMinor)}</td></tr>
${d.discountMinor ? `<tr class="tot"><td colspan="3" class="n">Descuento ${d.account.discountPercent}%</td><td class="n">−${m(d.discountMinor)}</td></tr>` : ""}
<tr class="tot"><td colspan="3" class="n">Total</td><td class="n">${m(d.totalMinor)}</td></tr></tbody></table>
<p class="note">Resumen interno de viajes realizados. No reemplaza la factura electrónica de AFIP/ARCA, que se emite por separado.</p>
<script>window.onload=()=>window.print()</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) throw new Error("El navegador bloqueó la ventana de impresión. Permití ventanas emergentes para este sitio.");
  w.document.write(html);
  w.document.close();
}
