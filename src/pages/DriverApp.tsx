// Driver app (installable web app). Spanish-first, built for a phone in a dashboard mount.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { TripStage } from "@shared/domain/types.ts";
import { Badge, Button, Field, Input, Logo } from "../components/ui";
import { Radio } from "../components/Radio";
import { FlightsPanel } from "../components/FlightsPanel";
import { backend, CommandError, type DriverJob, type DriverMe, type DriverOffer, type DriverStatement, type JobBoard, type StaffSession } from "../lib/backend";
import { cx, fmtDateShort, fmtLocalDate, fmtTime, formatMoney } from "../lib/format";

const SEND_EVERY_MS = 15_000;
const NEXT: Partial<Record<TripStage, { stage: TripStage; label: string }>> = {
  scheduled: { stage: "en_route", label: "Salgo para buscar" },
  en_route: { stage: "at_pickup", label: "Llegué al punto" },
  at_pickup: { stage: "onboard", label: "Pasajero a bordo" },
  onboard: { stage: "complete", label: "Viaje terminado" },
};
const STAGE_ES: Record<TripStage, string> = {
  scheduled: "Programado", en_route: "En camino", at_pickup: "En el punto", onboard: "Con pasajero", complete: "Finalizado", no_show: "No se presentó",
};
const ERR: Record<string, string> = {
  stale_version: "El trabajo cambió. Actualizamos los datos.", job_released: "Este trabajo ya no es tuyo.",
  off_shift: "Iniciá el turno primero.", schedule_conflict: "Ya tenés otro viaje en ese horario.",
  documents_missing: "Te falta cargar documentación (licencia, seguro, VTV o habilitación). Hablá con despacho.",
  documents_expired: "Tu documentación estará vencida en la fecha del viaje. Renovala y avisá a despacho.",
  outside_working_hours: "Ese viaje está fuera de tu horario.", vehicle_too_small: "Tu vehículo no alcanza para ese viaje.",
  not_a_driver: "Tu usuario no está vinculado a un chofer aprobado. Avisá a despacho.",
  invalid_transition: "Ese paso no corresponde ahora.", live_only: "La app de choferes funciona solo en modo en vivo.",
  claim_limit_reached: "Ya tenés el máximo de viajes de la bolsa para ese día.",
  release_window_closed: "Faltan menos de 24 h: pedile a despacho que lo reasigne.", job_in_progress: "El viaje ya empezó.",
  no_vehicle_allocated: "No tenés vehículo asignado para ese horario.",
};
const errMsg = (e: unknown) => (e instanceof CommandError ? ERR[e.code] ?? e.message : navigator.onLine ? "Error inesperado." : "Sin conexión. Reintentá cuando vuelva la señal.");

function Login({ onDone }: { onDone: (s: StaffSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { onDone(await backend.signIn(email, password)); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      <Logo />
      <h1 className="mt-6 text-2xl font-semibold">App de choferes</h1>
      {backend.mode === "demo" ? (
        <p className="mt-3 text-sm text-ink-300">La app de choferes necesita el modo en vivo (Supabase). En la demo podés ver el mapa en Despacho → Mapa.</p>
      ) : (
        <form onSubmit={submit} className="mt-6 grid gap-4">
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
          <Field label="Contraseña"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
          <Button type="submit">Ingresar</Button>
        </form>
      )}
    </div>
  );
}

export default function DriverApp() {
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  useEffect(() => { backend.staffSession().then(setSession); }, []);
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "manifest"; link.href = `${import.meta.env.BASE_URL}manifest.webmanifest`;
    document.head.appendChild(link);
    return () => link.remove();
  }, []);
  if (session === undefined) return null;
  if (!session) return <Login onDone={setSession} />;
  return <Driver onSignOut={async () => { await backend.signOut(); setSession(null); }} />;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return now;
}

function Driver({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<DriverMe | null>(null);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [jobs, setJobs] = useState<DriverJob[]>([]);
  const [tab, setTab] = useState<"jobs" | "board" | "offers" | "flights" | "radio" | "earnings">("jobs");
  const [jobBoard, setJobBoard] = useState<JobBoard | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const [m, o, j, bd] = await Promise.all([backend.driverMe(), backend.driverOffers(), backend.driverJobs(), backend.jobBoard()]);
      setMe(m); setOffers(o); setJobs(j); setJobBoard(bd); setSyncedAt(new Date()); setFatal(null);
    } catch (e) {
      if (e instanceof CommandError && (e.code === "not_a_driver" || e.code === "live_only")) setFatal(errMsg(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const unsub = backend.subscribe((t) => { if (t !== "driver_locations") refresh(); });
    const i = setInterval(refresh, 20_000);
    const on = () => { setOnline(true); refresh(); }, off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { unsub(); clearInterval(i); window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [refresh]);
  useEffect(() => { if (offers.length) setTab((t) => (t === "jobs" && !jobs.some(active) ? "offers" : t)); }, [offers.length, jobs]);

  const say = (ok: boolean, text: string) => { setToast({ ok, text }); setTimeout(() => setToast(null), 4000); };
  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try { await fn(); if (ok) say(true, ok); }
    catch (e) { say(false, errMsg(e)); }
    finally { setBusy(false); refresh(); }
  }

  const gps = useLocationSharing(!!me?.onShift);

  if (fatal) return <div className="mx-auto max-w-sm px-5 py-16"><Logo /><p className="mt-6 text-ink-300">{fatal}</p><Button variant="ghost" className="mt-4" onClick={onSignOut}>Salir</Button></div>;
  if (!me) return <div className="py-24 text-center text-ink-400">Cargando…</div>;

  const current = jobs.find(active);
  const upcoming = jobs.filter((j) => active(j) && j !== current);
  const done = jobs.filter((j) => !active(j));

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{me.fullName}</div>
            <div className="text-xs text-ink-400">{me.vehicle ? `${me.vehicle.plate} · ${me.vehicle.description}` : "Sin vehículo asignado"}</div>
          </div>
          <button onClick={() => act(() => backend.setShift(!me.onShift), me.onShift ? "Turno terminado." : "Turno iniciado. Compartiendo ubicación.")}
            disabled={busy} data-testid="shift-toggle"
            className={cx("rounded-full px-4 py-2 text-sm font-bold", me.onShift ? "bg-emerald-500 text-ink-950" : "bg-ink-700 text-white")}>
            {me.onShift ? "● En turno" : "Fuera de turno"}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          {!online ? <Badge tone="warn">Sin conexión · datos de {syncedAt ? fmtTime(syncedAt.toISOString()) : "—"}</Badge>
            : <span className="text-ink-400">Actualizado {syncedAt ? fmtTime(syncedAt.toISOString()) : "—"}</span>}
          {me.onShift && <span className={cx("ml-auto", gps.error ? "text-red-300" : "text-ink-400")}>
            {gps.error ?? (gps.sentAt ? `📍 ubicación enviada ${fmtTime(gps.sentAt)}${gps.accuracy ? ` (±${Math.round(gps.accuracy)} m)` : ""}` : "📍 buscando GPS…")}
          </span>}
        </div>
      </header>

      <main className="flex-1 px-4 pb-28 pt-4">
        {tab === "jobs" && (
          <>
            {current ? <JobCard job={current} now={now} busy={busy} act={act} primary /> : (
              <p className="rounded-2xl border border-ink-800 p-6 text-center text-ink-400">
                {me.onShift ? "Sin viajes en curso. Las ofertas aparecen en la pestaña Ofertas." : "Iniciá el turno para recibir ofertas."}
              </p>
            )}
            {upcoming.length > 0 && <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-ink-400">Próximos</h2>}
            {upcoming.map((j) => <JobCard key={j.assignmentId} job={j} now={now} busy={busy} act={act} />)}
            {current?.canDrop && <p className="-mt-1 mb-2 text-center text-[11px] text-ink-500">Podés devolver un viaje a la bolsa hasta {jobBoard?.releaseUntilHours ?? 24} h antes.</p>}
            {done.length > 0 && <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-ink-400">Terminados hoy</h2>}
            {done.map((j) => (
              <div key={j.assignmentId} className="mb-2 flex justify-between rounded-xl border border-ink-800 px-4 py-2 text-sm text-ink-400">
                <span className="font-mono">{j.reference}</span><span>{STAGE_ES[j.tripStage]}</span>
              </div>
            ))}
          </>
        )}

        {tab === "board" && jobBoard && (
          <div className="space-y-2" data-testid="board">
            <p className="mb-3 text-xs text-ink-400">
              Viajes anticipados para elegir. Máximo {jobBoard.maxPerDay} por día. Los datos del pasajero aparecen al tomarlo.
              Si nadie lo toma, {jobBoard.escalateHours} h antes se ofrece al chofer más cercano.
            </p>
            {!jobBoard.jobs.length && <p className="rounded-2xl border border-ink-800 p-6 text-center text-ink-400">No hay viajes en la bolsa para tu vehículo y horario.</p>}
            {jobBoard.jobs.map((b, i) => {
              const newDay = i === 0 || jobBoard.jobs[i - 1].pickupLocalDate !== b.pickupLocalDate;
              const held = jobBoard.claimsByDay[b.pickupLocalDate] ?? 0;
              const full = held >= jobBoard.maxPerDay;
              return (
                <div key={b.bookingId}>
                  {newDay && (
                    <h2 className="mb-2 mt-4 flex justify-between text-xs font-semibold uppercase tracking-wide text-ink-400">
                      <span className="first-letter:uppercase">{fmtLocalDate(b.pickupLocalDate)}</span>
                      <span className={full ? "text-amber-300" : ""}>tomados {held}/{jobBoard.maxPerDay}</span>
                    </h2>
                  )}
                  <div className="flex items-center gap-3 rounded-2xl border border-ink-800 bg-ink-900 p-3">
                    <div className="w-14 text-center">
                      <div className="text-lg font-bold tabular-nums">{fmtTime(b.pickupAt)}</div>
                      <div className="text-[10px] text-ink-400">~{b.estDurationMin} min</div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{b.direction === "from_airport" ? `${b.airport} → ${b.zone}` : `${b.zone} → ${b.airport}`}</div>
                      <div className="truncate text-xs text-ink-400">{b.passengers} pas. · {b.largeBags} valijas{b.flight ? ` · ${b.flight}` : ""}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-cab-400">{formatMoney(b.earningsMinor, b.currency, "es-AR")}</div>
                      <Button className="mt-1 px-3 py-1.5 text-xs" disabled={busy || full} data-testid="claim"
                        onClick={() => act(async () => {
                          const r = await backend.claim(b.bookingId);
                          if (r.outcome === "claimed") { say(true, "¡Viaje tuyo! Lo ves en Trabajos."); }
                          else say(false, r.outcome === "already_taken" ? "Otro chofer lo tomó primero." : "Ese viaje ya no está en la bolsa.");
                        })}>{full ? "Límite" : "Tomar"}</Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "offers" && (
          <div className="space-y-3">
            {!offers.length && <p className="rounded-2xl border border-ink-800 p-6 text-center text-ink-400">No hay ofertas abiertas.</p>}
            {offers.map((o) => {
              const left = Math.max(0, Math.round((new Date(o.expiresAt).getTime() - now) / 1000));
              return (
                <div key={o.id} className="rounded-2xl border border-cab-500/40 bg-cab-500/5 p-4" data-testid="offer">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-2xl font-bold tabular-nums">{fmtTime(o.pickupAt)}</div>
                      <div className="text-xs capitalize text-ink-400">{fmtDateShort(o.pickupAt)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-cab-400">{formatMoney(o.earningsMinor, o.currency, "es-AR")}</div>
                      <div className={cx("text-xs tabular-nums", left < 60 ? "text-red-300" : "text-ink-400")}>vence en {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-sm">
                    {o.direction === "from_airport" ? `${o.airport} → ${o.zone}` : `${o.zone} → ${o.airport}`}{o.flight ? ` · vuelo ${o.flight}` : ""}
                  </div>
                  <div className="text-xs text-ink-400">{o.passengers} pas. · {o.largeBags} valijas · {o.carryOn} mano · ~{o.estDurationMin} min</div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button variant="outline" disabled={busy || left === 0} onClick={() => act(async () => { await backend.respondOffer(o.id, false); }, "Oferta rechazada.")}>Rechazar</Button>
                    <Button disabled={busy || left === 0} data-testid="accept-offer" onClick={() => act(async () => {
                      const r = await backend.respondOffer(o.id, true);
                      if (r.outcome === "accepted") { say(true, "¡Viaje tuyo! Lo ves en Trabajos."); setTab("jobs"); }
                      else say(false, r.outcome === "expired" ? "La oferta venció." : "Otro chofer lo tomó primero.");
                    })}>Aceptar</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === "flights" && <FlightsPanel showMine compact />}

        {tab === "radio" && (
          <div className="pt-6">
            <p className="mb-4 text-center text-sm text-ink-400">Canal de despacho. Dejá la app abierta para escuchar.</p>
            <Radio disabled={!me.onShift} />
            {!me.onShift && <p className="mt-3 text-center text-xs text-ink-500">La radio se habilita durante el turno.</p>}
          </div>
        )}

        {tab === "earnings" && (
          <div className="grid gap-3">
            {([["Hoy", me.earnings.todayMinor], ["A cobrar (pendiente de liquidar)", me.earnings.accruedMinor], ["Liquidado", me.earnings.settledMinor]] as const).map(([l, v]) => (
              <div key={l} className="flex items-center justify-between rounded-2xl border border-ink-800 px-4 py-4">
                <span className="text-sm text-ink-300">{l}</span>
                <span className="text-xl font-bold tabular-nums">{formatMoney(v, me.earnings.currency, "es-AR")}</span>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-4">
              <span className="text-sm text-amber-200">Efectivo cobrado a rendir</span>
              <span className="text-xl font-bold tabular-nums">{formatMoney(me.cashToHandInMinor, me.earnings.currency, "es-AR")}</span>
            </div>
            <p className="text-xs text-ink-500">{me.earnings.trips} viaje(s). SoyTuTaxi realiza los pagos a choferes.</p>
            <MyPay />
          </div>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-800 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto grid max-w-md grid-cols-6">
          {([["jobs", "Trabajos", jobs.filter(active).length], ["board", "Bolsa", jobBoard?.jobs.length ?? 0], ["offers", "Ofertas", offers.length], ["flights", "Vuelos", 0], ["radio", "Radio", 0], ["earnings", "Ganancias", 0]] as const).map(([k, l, n]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("relative py-4 text-[12px] font-semibold", tab === k ? "text-cab-400" : "text-ink-400")}>
              {l}{n > 0 && <span className="absolute right-1 top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-cab-500 px-1 text-[11px] text-ink-950">{n}</span>}
            </button>
          ))}
        </div>
        <button onClick={onSignOut} className="absolute -top-7 right-2 text-[11px] text-ink-500">Salir</button>
      </nav>

      {toast && <div role="status" className={cx("fixed inset-x-4 bottom-20 z-30 mx-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium shadow-lg", toast.ok ? "bg-emerald-500 text-ink-950" : "bg-red-500 text-white")}>{toast.text}</div>}
    </div>
  );
}

const DOC_ES: Record<string, string> = { license: "Licencia", professional_license: "Licencia profesional", insurance: "Seguro", vtv: "VTV", permit: "Habilitación", other: "Otro" };

/** Statement (pending + past settlements) and document expiry, live mode only. */
function MyPay() {
  const [st, setSt] = useState<DriverStatement | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  useEffect(() => { backend.driverStatement(batch).then(setSt, () => setSt(null)); }, [batch]);
  if (!st) return null;
  const t = st.totals[0];
  return (
    <div className="grid gap-3" data-testid="my-pay">
      {st.documentProblem && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {st.documentProblem.startsWith("documents_missing") ? "Falta" : "Venció"}: {DOC_ES[st.documentProblem.split(":")[1]] ?? ""}. Sin documentación vigente no podés recibir viajes.
        </div>
      )}
      <div className="rounded-2xl border border-ink-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">{batch ? "Liquidación cerrada" : "Pendiente de liquidar"}</span>
          {batch && <button onClick={() => setBatch(null)} className="text-xs text-cab-400">← Pendiente</button>}
        </div>
        {st.lines.slice(-30).map((l, i) => (
          <div key={i} className="flex justify-between border-t border-ink-800 py-1.5 text-xs">
            <span className="text-ink-300">{fmtDateShort(l.at)} · {l.kind === "trip" ? `Viaje ${l.reference}` : l.kind === "cash" ? `Efectivo ${l.reference}` : `Ajuste: ${l.note}`}</span>
            <span className={cx("tabular-nums", l.cashMinor ? "text-amber-300" : "text-white")}>{l.cashMinor ? `−${formatMoney(l.cashMinor, l.currency, "es-AR")}` : formatMoney(l.earningMinor, l.currency, "es-AR")}</span>
          </div>
        ))}
        {t && <div className="mt-2 flex justify-between border-t border-ink-700 pt-2 text-sm font-semibold">
          <span>{t.netMinor >= 0 ? "Te pagamos" : "A rendir"}</span><span className="tabular-nums">{formatMoney(Math.abs(t.netMinor), t.currency, "es-AR")}</span>
        </div>}
        {!st.lines.length && <p className="py-2 text-xs text-ink-500">Sin movimientos pendientes.</p>}
      </div>
      {st.batches.length > 0 && (
        <div className="rounded-2xl border border-ink-800 px-4 py-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wide text-ink-400">Liquidaciones</div>
          {st.batches.map((b) => (
            <button key={b.id} onClick={() => setBatch(b.id)} className="flex w-full justify-between py-1.5 text-left">
              <span className="text-ink-300">{fmtDateShort(b.at)} · {b.trips} viaje(s)</span><span className="tabular-nums text-white">{formatMoney(b.netMinor, b.currency, "es-AR")}</span>
            </button>
          ))}
        </div>
      )}
      {st.documents.length > 0 && (
        <div className="rounded-2xl border border-ink-800 px-4 py-3 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wide text-ink-400">Mi documentación</div>
          {st.documents.map((d) => (
            <div key={d.kind} className="flex justify-between py-1">
              <span className="text-ink-300">{DOC_ES[d.kind]}</span>
              <span className={d.status === "ok" ? "text-emerald-300" : d.status === "expiring" ? "text-amber-300" : "text-red-300"}>
                {d.status === "expired" ? "Vencida " : "Vence "}{fmtLocalDate(d.expiresOn, "es-AR")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const active = (j: DriverJob) => j.tripStage !== "complete" && j.tripStage !== "no_show";

function JobCard({ job: j, now, busy, act, primary = false }: {
  job: DriverJob; now: number; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => void; primary?: boolean;
}) {
  const [confirmDrop, setConfirmDrop] = useState(false);
  const next = NEXT[j.tripStage];
  const target = j.tripStage === "onboard" ? j.dropoff : j.pickup;
  const q = encodeURIComponent(target.lat != null && target.lng != null ? `${target.lat},${target.lng}` : `${target.label}, Buenos Aires`);
  const mins = Math.round((new Date(j.pickupAt).getTime() - now) / 60000);
  return (
    <div className={cx("mb-3 rounded-2xl border p-4", primary ? "border-cab-500/50 bg-ink-900" : "border-ink-800")} data-testid="job">
      <div className="flex items-start justify-between">
        <div>
          <div className={cx("font-bold tabular-nums", primary ? "text-3xl" : "text-xl")}>{fmtTime(j.pickupAt)}</div>
          <div className="text-xs text-ink-400">{mins > 0 ? `en ${mins >= 120 ? Math.round(mins / 60) + " h" : mins + " min"}` : "ahora"} · <span className="font-mono">{j.reference}</span></div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge tone={j.state === "reserving" ? "held" : "confirmed"}>{j.state === "reserving" ? "Esperando pago" : STAGE_ES[j.tripStage]}</Badge>
          {j.claimSource === "board" && <span className="text-[10px] text-ink-500">de la bolsa</span>}
        </div>
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div><dt className="inline text-ink-400">Desde: </dt><dd className="inline">{j.pickup.label}</dd></div>
        <div><dt className="inline text-ink-400">Hasta: </dt><dd className="inline">{j.dropoff.label}</dd></div>
        {j.flight && <div><dt className="inline text-ink-400">Vuelo: </dt><dd className="inline font-mono">{j.flight}</dd></div>}
        {j.direction === "from_airport" && primary && <div className="text-xs text-ink-400">{j.meetingPoint}</div>}
        <div className="text-ink-300">{j.passengers} pas. · {j.largeBags} valijas · {j.carryOn} mano</div>
        <div><dt className="inline text-ink-400">Pasajero: </dt><dd className="inline">{j.passenger.name}{j.passenger.locale === "en" ? " (EN)" : ""}</dd></div>
        {j.notes && <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-200">{j.notes}</div>}
        <div className="text-ink-300">{j.paymentMode === "prepaid" ? "Pago online" : `Cobrar en efectivo: ${j.amountMinor !== null ? formatMoney(j.amountMinor, j.currency!, "es-AR") : "—"}`}</div>
      </dl>
      {primary && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${q}`} target="_blank" rel="noreferrer"><Button variant="outline" className="w-full">🧭 Navegar</Button></a>
          {j.passenger.phone
            ? <a href={`https://wa.me/${j.passenger.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer"><Button variant="outline" className="w-full">💬 WhatsApp</Button></a>
            : <span />}
        </div>
      )}
      {primary && j.state === "confirmed" && next && (
        <Button className="mt-3 w-full py-4 text-base" disabled={busy} data-testid="next-stage"
          onClick={() => act(() => backend.progress(j.assignmentId, next.stage, j.version), next.stage === "complete" ? "Viaje terminado. ¡Gracias!" : undefined)}>
          {next.label}
        </Button>
      )}
      {j.canDrop && (
        confirmDrop ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setConfirmDrop(false)}>No</Button>
            <Button variant="outline" className="border-red-500/40 text-red-300" disabled={busy}
              onClick={() => act(() => backend.giveBack(j.assignmentId), "Viaje devuelto a la bolsa.")}>Sí, devolver</Button>
          </div>
        ) : (
          <button className="mt-2 w-full text-center text-xs text-ink-400 hover:text-white" onClick={() => setConfirmDrop(true)}>Devolver a la bolsa</button>
        )
      )}
      {primary && j.state === "confirmed" && j.tripStage === "at_pickup" && (
        <Button variant="ghost" className="mt-1 w-full text-red-300" disabled={busy}
          onClick={() => act(() => backend.progress(j.assignmentId, "no_show", j.version), "No-show informado a despacho.")}>El pasajero no se presentó</Button>
      )}
    </div>
  );
}

/** Watches GPS while on shift and sends the latest fix every ~15 s; keeps the screen awake. */
function useLocationSharing(on: boolean) {
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<GeolocationPosition | null>(null);
  const lastSent = useRef<number>(0);

  useEffect(() => {
    if (!on) { setSentAt(null); setError(null); return; }
    if (!("geolocation" in navigator)) { setError("Este teléfono no tiene GPS disponible."); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => { latest.current = p; setAccuracy(p.coords.accuracy); setError(null); },
      (e) => setError(e.code === e.PERMISSION_DENIED ? "Permití la ubicación para aparecer en el mapa." : "Sin señal GPS."),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
    const send = async () => {
      const p = latest.current;
      if (!p || p.timestamp <= lastSent.current) return;
      try {
        await backend.reportLocation({
          lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
          heading: p.coords.heading, speed: p.coords.speed, at: new Date(p.timestamp).toISOString(),
        });
        lastSent.current = p.timestamp;
        setSentAt(new Date().toISOString());
      } catch (e) {
        if (e instanceof CommandError && e.code === "off_shift") return;
        setError(navigator.onLine ? "No se pudo enviar la ubicación." : "Sin conexión: la ubicación se enviará al volver la señal.");
      }
    };
    const first = setTimeout(send, 2_000);
    const timer = setInterval(send, SEND_EVERY_MS);

    // Keep the screen on in the dash mount (where supported).
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    const acquire = () => { if (wl && document.visibilityState === "visible") wl.request("screen").then((l) => { lock = l; }).catch(() => {}); };
    acquire();
    const vis = () => { if (document.visibilityState === "visible") { acquire(); send(); } };
    document.addEventListener("visibilitychange", vis);

    return () => {
      navigator.geolocation.clearWatch(id); clearTimeout(first); clearInterval(timer);
      document.removeEventListener("visibilitychange", vis); lock?.release().catch(() => {});
    };
  }, [on]);

  return { sentAt, accuracy, error };
}
