import { tr } from "../lib/staffLang";
import { useCallback, useEffect, useMemo, useState } from "react";
import { backend, CommandError, type AdminDriver, type ApprovalStatus, type VehicleClassOption } from "../lib/backend";
import { cx, fmtDateTime } from "../lib/format";
import { Badge, Button, Field, Input } from "./ui";

// Despacho → Choferes → Plantel: every driver with their car and login, "+ Nuevo chofer", invitation links,
// and applications from "Quiero ser chofer" to approve or reject.

const ST: Record<ApprovalStatus, [string, string]> = {
  pending: ["Solicitud", "warn"], approved: ["Aprobado", "confirmed"], suspended: ["Suspendido", "cancelled"], rejected: ["Rechazado", "cancelled"],
};
const ERR: Record<string, string> = {
  forbidden: "Solo admin o despacho pueden hacer esto.", invalid_name: "Escribí nombre y apellido.",
  invalid_phone: "WhatsApp inválido: con código de país, ej. +54 9 11 1234-5678.", phone_in_use: "Ese WhatsApp ya es de otro chofer.",
  invalid_plate: "Patente inválida (ej. AB123CD).", invalid_vehicle_class: "Elegí el tipo de vehículo.",
  vehicle_in_use: "Ese vehículo ya lo maneja otro chofer.", driver_has_login: "Este chofer ya tiene acceso a la app.",
  template_not_approved: "El chofer no escribió en las últimas 24 h y la plantilla todavía no está aprobada: copiá el link y mandáselo vos.",
  template_missing: "Falta la plantilla de WhatsApp: copiá el link y mandáselo vos.", whatsapp_not_configured: "WhatsApp no está conectado.",
};
const errText = (e: unknown) => e instanceof CommandError ? ERR[e.code] ?? (e.message && e.message !== e.code ? e.message : e.code) : (e as Error).message;

export function driverAppLink(token?: string) {
  const base = new URL(`${import.meta.env.BASE_URL}chofer`, window.location.origin).toString();
  return token ? `${base}?invite=${token}` : base;
}

export function DriverRoster() {
  const [list, setList] = useState<AdminDriver[] | null>(null);
  const [classes, setClasses] = useState<VehicleClassOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [edit, setEdit] = useState<AdminDriver | "new" | null>(null);
  const [invite, setInvite] = useState<{ d: AdminDriver; link: string } | null>(null);
  const [filter, setFilter] = useState<"all" | ApprovalStatus>("all");

  const load = useCallback(() => backend.adminDrivers().then((l) => { setList(l); setErr(null); }, (e) => setErr(errText(e))), []);
  useEffect(() => { load(); backend.vehicleClassOptions().then(setClasses).catch(() => {}); }, [load]);
  const pending = useMemo(() => (list ?? []).filter((d) => d.status === "pending"), [list]);
  const shown = useMemo(() => (list ?? []).filter((d) => filter === "all" || d.status === filter), [list, filter]);
  const say = (t: string) => { setFlash(t); setTimeout(() => setFlash(null), 6000); };

  async function review(d: AdminDriver, status: ApprovalStatus) {
    const note = status === "approved" ? null : window.prompt(tr(status === "rejected" ? "Motivo del rechazo (lo ve el chofer):" : "Motivo de la suspensión:")) ?? undefined;
    if (note === undefined) return;
    try {
      await backend.setDriverApproval(d.id, status, note);
      if (status === "approved") {
        const sent = await backend.notifyDriver(d.id, "approved", driverAppLink()).then(() => true, () => false);
        say(`${d.fullName} aprobado${sent ? " · le avisamos por WhatsApp" : ""}.`);
      } else say(`${d.fullName}: ${ST[status][0].toLowerCase()}.`);
      load();
    } catch (e) { setErr(errText(e)); }
  }
  async function makeInvite(d: AdminDriver) {
    try { const r = await backend.driverInvite(d.id); setInvite({ d, link: driverAppLink(r.token) }); load(); }
    catch (e) { setErr(errText(e)); }
  }

  if (!list) return <p className="text-sm text-ink-400">{err ?? "Cargando…"}</p>;
  return (
    <div data-testid="driver-roster">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-ink-900 p-1 text-xs">
          {(["all", "pending", "approved", "suspended", "rejected"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={cx("rounded-md px-2.5 py-1 font-medium", filter === k ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white")}>
              {k === "all" ? `Todos (${list.length})` : k === "pending" ? `Solicitudes (${pending.length})` : ST[k][0] + "s"}
            </button>
          ))}
        </div>
        <Button className="ml-auto py-2" onClick={() => setEdit("new")} data-testid="new-driver">+ Nuevo chofer</Button>
      </div>
      {pending.length > 0 && filter === "all" && (
        <p className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
          {pending.length === 1 ? "Hay 1 solicitud" : `Hay ${pending.length} solicitudes`} de «Quiero ser chofer» para revisar. Mirá sus datos y documentos antes de aprobar.
        </p>
      )}
      {flash && <p role="status" className="mb-3 rounded-xl bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">{flash}</p>}
      {err && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-200">{err} <button className="ml-2 underline" onClick={() => setErr(null)}>ok</button></p>}

      <div className="overflow-x-auto rounded-2xl border border-ink-800">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr><th className="px-3 py-2">Chofer</th><th className="px-3 py-2">Vehículo</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">App</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {shown.map((d) => (
              <tr key={d.id} className={cx(d.status === "pending" && "bg-amber-500/5")} data-testid={`driver-row-${d.fullName}`}>
                <td className="px-3 py-2">
                  <div className="font-medium text-white">{d.fullName}</div>
                  <div className="text-xs text-ink-400">{d.whatsapp ?? "sin WhatsApp"}{d.email ? ` · ${d.email}` : ""}</div>
                  {d.source === "signup" && <div className="text-[11px] text-ink-500">Se anotó solo · {fmtDateTime(d.createdAt)}</div>}
                  {d.reviewNote && <div className="text-[11px] text-ink-400">Nota: {d.reviewNote}</div>}
                </td>
                <td className="px-3 py-2">
                  {d.vehicle ? <><div className="font-mono">{d.vehicle.plate}</div>
                    <div className="text-xs text-ink-400">{classes.find((c) => c.code === d.vehicle!.vehicleClass)?.nameEs ?? d.vehicle.vehicleClass}{d.vehicle.description ? ` · ${d.vehicle.description}` : ""}</div></>
                    : <span className="text-xs text-ink-500">sin vehículo</span>}
                </td>
                <td className="px-3 py-2"><Badge tone={ST[d.status][1]}>{ST[d.status][0]}</Badge>{!d.active && <span className="ml-1 text-xs text-ink-500">inactivo</span>}</td>
                <td className="px-3 py-2 text-xs">
                  {d.hasLogin ? <span className="text-emerald-300">✓ tiene acceso</span> : d.inviteOpen ? <span className="text-amber-200">invitación enviada</span> : <span className="text-ink-500">sin acceso</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {d.status === "pending" && <>
                      <Button className="py-1 text-xs" onClick={() => review(d, "approved")}>Aprobar</Button>
                      <Button variant="outline" className="py-1 text-xs" onClick={() => review(d, "rejected")}>Rechazar</Button>
                    </>}
                    {!d.hasLogin && d.status === "approved" && <Button variant="outline" className="py-1 text-xs" onClick={() => makeInvite(d)} data-testid="invite-driver">{d.inviteOpen ? "Nuevo link" : "Invitar"}</Button>}
                    {d.status === "approved" && <Button variant="ghost" className="py-1 text-xs" onClick={() => review(d, "suspended")}>Suspender</Button>}
                    {(d.status === "suspended" || d.status === "rejected") && <Button variant="outline" className="py-1 text-xs" onClick={() => review(d, "approved")}>Reactivar</Button>}
                    <Button variant="ghost" className="py-1 text-xs" onClick={() => setEdit(d)}>Editar</Button>
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-400">No hay choferes en esta lista.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-500">Los choferes también se pueden anotar solos desde la app («Quiero ser chofer»): aparecen arriba como solicitud y no reciben viajes hasta que los aprobás.</p>

      {edit && <DriverForm d={edit === "new" ? null : edit} classes={classes} onClose={() => setEdit(null)}
        onSaved={async (id, isNew) => {
          setEdit(null); await load();
          if (isNew) { const fresh = (await backend.adminDrivers()).find((x) => x.id === id); if (fresh) makeInvite(fresh); }
          else say("Cambios guardados.");
        }} />}
      {invite && <InviteDialog d={invite.d} link={invite.link} onClose={() => setInvite(null)} onSent={(t) => { setInvite(null); say(t); load(); }} />}
    </div>
  );
}

function DriverForm({ d, classes, onClose, onSaved }: { d: AdminDriver | null; classes: VehicleClassOption[]; onClose: () => void; onSaved: (id: string, isNew: boolean) => void }) {
  const [f, setF] = useState({
    fullName: d?.fullName ?? "", whatsapp: d?.whatsapp ?? "+549", vehicleClass: d?.vehicle?.vehicleClass ?? classes[0]?.code ?? "",
    plate: d?.vehicle?.plate ?? "", vehicleDesc: d?.vehicle?.description ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await backend.saveDriver({ id: d?.id ?? null, ...f }); onSaved(r.id, !d); }
    catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label={d ? "Editar chofer" : "Nuevo chofer"}>
      <form onSubmit={submit} className="w-full max-w-lg rounded-2xl border border-ink-700 bg-ink-950 p-5 shadow-2xl" data-testid="driver-form">
        <h3 className="mb-4 text-lg font-semibold">{d ? `Editar · ${d.fullName}` : "Nuevo chofer"}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre y apellido"><Input value={f.fullName} onChange={set("fullName")} required data-testid="driver-name" /></Field>
          <Field label="WhatsApp (con código de país)"><Input type="tel" value={f.whatsapp} onChange={set("whatsapp")} required data-testid="driver-phone" /></Field>
          <Field label="Tipo de vehículo">
            <select value={f.vehicleClass} onChange={set("vehicleClass")} className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-white" data-testid="driver-class">
              {classes.map((c) => <option key={c.code} value={c.code}>{c.nameEs} · hasta {c.maxPassengers} pax</option>)}
            </select>
          </Field>
          <Field label="Patente"><Input value={f.plate} onChange={set("plate")} placeholder="AB123CD" required data-testid="driver-plate" /></Field>
          <div className="sm:col-span-2"><Field label="Modelo y color (opcional)"><Input value={f.vehicleDesc} onChange={set("vehicleDesc")} placeholder="Toyota Corolla gris" /></Field></div>
        </div>
        {!d && <p className="mt-3 text-xs text-ink-400">Al guardar te damos un link de invitación para que el chofer cree su acceso a la app (también se lo mandamos por WhatsApp).</p>}
        {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={busy} data-testid="driver-save">{busy ? "Guardando…" : d ? "Guardar" : "Crear chofer"}</Button>
        </div>
      </form>
    </div>
  );
}

function InviteDialog({ d, link, onClose, onSent }: { d: AdminDriver; link: string; onClose: () => void; onSent: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const text = `Hola ${d.fullName.split(" ")[0]}, te sumamos como chofer de SoyTuTaxi. Creá tu acceso a la app de choferes acá: ${link} (vence en 7 días)`;
  async function send() {
    setBusy(true); setErr(null);
    try { await backend.notifyDriver(d.id, "invite", link); onSent(`Invitación enviada a ${d.fullName} por WhatsApp.`); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Invitación">
      <div className="w-full max-w-lg rounded-2xl border border-ink-700 bg-ink-950 p-5 shadow-2xl" data-testid="invite-dialog">
        <h3 className="text-lg font-semibold">Invitación para {d.fullName}</h3>
        <p className="mt-1 text-sm text-ink-300">Con este link el chofer elige su email y contraseña para la app. Sirve una sola vez y vence en 7 días.</p>
        <div className="mt-3 break-all rounded-xl bg-ink-900 p-3 font-mono text-xs text-ink-200" data-testid="invite-link">{link}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={send} disabled={busy || !d.whatsapp} data-testid="invite-send">{busy ? "Enviando…" : `Enviar por WhatsApp a ${d.whatsapp ?? "—"}`}</Button>
          <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "✓ Copiado" : "Copiar mensaje"}</Button>
          <Button variant="ghost" onClick={onClose}>Cerrar</Button>
        </div>
        {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
      </div>
    </div>
  );
}
