import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { addDaysLocal, localToUtc, utcToLocalDate } from "@shared/domain/time.ts";
import type { Driver } from "@shared/domain/types.ts";
import { Badge, Button, Field, Input, Logo, Select } from "../components/ui";
import { backend, CommandError, type BoardRow, type DispatchRow, type StaffSession, type TripEvent } from "../lib/backend";
import { DriverMap, STATUS_COLOR, STATUS_ES } from "../components/DriverMap";
import { Radio } from "../components/Radio";
import { WhatsAppInbox } from "../components/WhatsAppInbox";
import { FlightsPanel } from "../components/FlightsPanel";
import { DriversAdmin } from "../components/DriversAdmin";
import { ReportsPanel } from "../components/ReportsPanel";
import { AccountsPanel } from "../components/AccountsPanel";
import { WhatsAppSetup } from "../components/WhatsAppSetup";
import { NewBookingsBell } from "../components/NewBookings";
import { CallDesk, CallModeSwitch, useCallSettings } from "../components/CallDesk";
import { useNavigate } from "react-router-dom";
import { cx, fmtDateTime, fmtLocalDate, fmtTime, formatMoney } from "../lib/format";
import { useConfig } from "./BookingPage";

// Spanish-first operational screen. Labels are centralised for later locale work.
const L = {
  title: "Despacho", bookings: "Reservas", schedule: "Agenda", map: "Mapa", whatsapp: "WhatsApp", flights: "Vuelos", drivers: "Choferes", accounts: "Cuentas", reports: "Informes", today: "Hoy", tomorrow: "Mañana",
  all: "Todos", airport: "Aeropuerto", state: "Estado", driver: "Chofer", payment: "Pago", search: "Buscar ref., pasajero, vuelo…",
  unassigned: "Sin asignar", none: "No hay reservas para este día con estos filtros.", newBooking: "Nueva reserva",
  signIn: "Ingresar", signOut: "Salir", alerts: "Alertas",
  timeline: "Historial", passenger: "Pasajero", trip: "Viaje", pickup: "Búsqueda", vehicle: "Vehículo", flight: "Vuelo",
  notes: "Notas", source: "Canal", ref: "Ref.", pax: "Pax", money: "Importe",
};
const STATE_ES: Record<string, string> = {
  requested: "Solicitada", needs_driver: "Sin chofer", held: "Reservada (hold)", confirmed: "Confirmada", closed: "Cerrada", cancelled: "Cancelada",
};
const STAGE_ES: Record<string, string> = { scheduled: "programado", en_route: "en camino", at_pickup: "en el punto", onboard: "con pasajero", complete: "finalizado", no_show: "no se presentó" };
const PAY_ES: Record<string, string> = { prepaid: "Online", pay_on_pickup_cash: "Efectivo", pay_on_pickup_card: "Tarjeta al chofer", account: "A cuenta" };
const COLLECT_ES: Record<string, string> = { awaiting_payment: "pago pendiente", pending_collection: "a cobrar", collected: "cobrado", waived: "bonificado", not_applicable: "" };
const VC_ES: Record<string, string> = { sedan_premium: "Sedán", minivan: "Minivan", taxibus: "TaxiBus" };
const SOURCE_ES: Record<string, string> = { web: "Web", whatsapp: "WhatsApp", staff: "Despacho", phone: "Teléfono", voice: "Voz" };

export function StaffLogin({ onDone, title = L.title }: { onDone: (s: StaffSession) => void; title?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try { onDone(await backend.signIn(email, password)); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <div className="mx-auto max-w-sm px-5 py-24">
      <div className="rounded-3xl border border-ink-700 bg-ink-900 p-7">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{title}</h1>
        {backend.mode === "demo" ? (
          <>
            <p className="mt-2 text-sm text-ink-300">Modo demo: entrás como despachante de prueba.</p>
            <Button className="mt-6 w-full" onClick={async () => onDone(await backend.signInDemo())} data-testid="demo-signin">Entrar como despacho (demo)</Button>
          </>
        ) : (
          <form onSubmit={submit} className="mt-5 grid gap-4">
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
            <Field label="Contraseña"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
            {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
            <Button type="submit">{L.signIn}</Button>
          </form>
        )}
      </div>
    </div>
  );
}

function dayBounds(date: string) {
  return { from: localToUtc(date, "00:00").toISOString(), to: localToUtc(addDaysLocal(date, 1), "00:00").toISOString() };
}

export default function DispatchPage() {
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  useEffect(() => { backend.staffSession().then(setSession); }, []);
  if (session === undefined) return null;
  if (!session) return <StaffLogin onDone={setSession} />;
  return <Dispatch session={session} onSignOut={async () => { await backend.signOut(); setSession(null); }} />;
}

function Dispatch({ session, onSignOut }: { session: StaffSession; onSignOut: () => void }) {
  const today = utcToLocalDate(new Date());
  const [date, setDate] = useState(addDaysLocal(today, 1));
  const [tab, setTab] = useState<"schedule" | "map" | "bookings" | "whatsapp" | "flights" | "drivers" | "accounts" | "reports">("schedule");
  const [waPending, setWaPending] = useState(0);
  const [atDesk, setAtDesk] = useState(0);
  useEffect(() => {
    const tick = () => backend.waConversations().then((c) => setWaPending(c.filter((x) => x.needsStaff && !x.handoffOwner).length)).catch(() => {});
    tick();
    const i = setInterval(tick, 30_000);
    return () => clearInterval(i);
  }, []);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [airport, setAirport] = useState("");
  const [state, setState] = useState("");
  const [driverId, setDriverId] = useState("");
  const [pay, setPay] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<DispatchRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cfg = useConfig();
  const navigate = useNavigate();
  const calls = useCallSettings();
  // A new booking from any channel: jump to its day and open it (bookings still at the booking desk open in the Central).
  const openNew = useCallback((r: DispatchRow) => {
    if (r.deskHold) { navigate("/central"); return; }
    setDate(r.pickupLocalDate || utcToLocalDate(new Date(r.agreedPickupAt)));
    setTab((t) => (t === "schedule" || t === "bookings" || t === "map" ? t : "schedule"));
    setSelected(r);
  }, [navigate]);
  // Opened from the Central's bell with ?ref=STT-…: show that booking.
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (!ref) return;
    backend.deskRows().then((list) => { const r = list.find((x) => x.reference === ref); if (r) openNew(r); else { setQ(ref); setTab("bookings"); } }).catch(() => {});
  }, [openNew]);
  const turnaround = cfg?.policy.turnaroundMinutes ?? 20;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { from, to } = dayBounds(date);
      const [r, d, bd] = await Promise.all([backend.dispatchRows(from, to), backend.drivers(), backend.driverBoard().catch(() => [] as BoardRow[])]);
      // Bookings still at the booking desk (manual mode) aren't dispatch's yet.
      setAtDesk(r.filter((x) => x.deskHold).length);
      const mine = r.filter((x) => !x.deskHold);
      setRows(mine); setDrivers(d); setBoard(bd); setLoadedAt(new Date());
      setSelected((cur) => (cur ? mine.find((x) => x.id === cur.id) ?? cur : cur));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);
  // Live updates: positions refresh the map; booking/assignment/offer changes reload the day.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = backend.subscribe((table) => {
      if (table === "driver_locations") { backend.driverBoard().then(setBoard).catch(() => {}); return; }
      if (t) clearTimeout(t);
      t = setTimeout(load, 400);
    });
    const poll = setInterval(() => backend.driverBoard().then(setBoard).catch(() => {}), 15_000);
    return () => { unsub(); clearInterval(poll); if (t) clearTimeout(t); };
  }, [load]);

  const filtered = useMemo(() => rows.filter((r) =>
    (!airport || r.airport === airport) && (!state || r.state === state) && (!pay || r.paymentMode === pay) &&
    (!driverId || (driverId === "none" ? !r.driverId : r.driverId === driverId)) &&
    (!q || `${r.reference} ${r.passengerName} ${r.flightDesignator ?? ""} ${r.pickupPlace.label} ${r.dropoffPlace.label}`.toLowerCase().includes(q.toLowerCase()))
  ), [rows, airport, state, pay, driverId, q]);

  const alerts = useMemo(() => {
    const now = Date.now();
    const H = (cfg?.policy.escalation.unassigned_alert_hours_before ?? 12) * 3600_000;
    const out: { tone: string; text: string; row: DispatchRow }[] = [];
    for (const r of rows) {
      const t = new Date(r.agreedPickupAt).getTime();
      if (r.state === "needs_driver" && t - now < H && t > now) out.push({ tone: "needs_driver", text: `${r.reference} sin chofer · búsqueda ${fmtTime(r.agreedPickupAt)}`, row: r });
      if (r.state === "held" && r.holdExpiresAt) out.push({ tone: "held", text: `${r.reference} hold vence ${fmtTime(r.holdExpiresAt)}`, row: r });
      if (r.flightExceptionReason) out.push({ tone: "warn", text: `${r.reference} sin vuelo: ${r.flightExceptionReason}`, row: r });
      if (r.state === "needs_driver" && r.autoDispatch) out.push({ tone: "warn", text: `${r.reference} oferta automática · ronda ${r.autoRounds}`, row: r });
    }
    return out;
  }, [rows, cfg]);

  const counts = useMemo(() => ({
    total: rows.filter((r) => r.state !== "cancelled").length,
    needs: rows.filter((r) => r.state === "needs_driver").length,
    held: rows.filter((r) => r.state === "held").length,
    confirmed: rows.filter((r) => r.state === "confirmed").length,
  }), [rows]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4 px-5 py-3">
          <Logo />
          <span className="rounded-md bg-ink-800 px-2 py-0.5 text-xs font-semibold text-ink-300">{L.title}</span>
          <nav className="ml-4 flex gap-1 rounded-lg bg-ink-900 p-1" role="tablist">
            {(["schedule", "map", "bookings", "whatsapp", "flights", "drivers", "accounts", "reports"] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={cx("rounded-md px-3 py-1.5 text-sm font-medium", tab === k ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white")}>
                {L[k]}{k === "whatsapp" && waPending > 0 && <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">{waPending}</span>}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <CallModeSwitch compact settings={calls.settings} onChange={calls.change} />
            {backend.simulateCall && <Button variant="outline" className="py-1.5 text-xs" onClick={() => backend.simulateCall!()} data-testid="simulate-call">📞 Simular</Button>}
            <NewBookingsBell onOpen={openNew} />
            <Radio compact disabled={backend.mode === "demo"} />
            <PaymentSettingsButton />
            <Link to="/central" className="text-ink-300 hover:text-white">Central →</Link>
            <Link to="/despacho/nueva"><Button className="py-2">+ {L.newBooking}</Button></Link>
            <span className="hidden text-ink-400 md:inline">{session.label}</span>
            <Button variant="ghost" className="px-2 py-2" onClick={onSignOut}>{L.signOut}</Button>
          </div>
        </div>

        <div className={cx("flex flex-wrap items-end gap-3 border-t border-ink-800 px-5 py-3", ["whatsapp", "flights", "drivers", "accounts", "reports"].includes(tab) && "hidden")}>
          <div className="flex items-center gap-1">
            <Button variant="outline" className="px-3 py-2" aria-label="Día anterior" onClick={() => setDate(addDaysLocal(date, -1))}>‹</Button>
            <div className="w-44"><Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="py-2" aria-label="Fecha" /></div>
            <Button variant="outline" className="px-3 py-2" aria-label="Día siguiente" onClick={() => setDate(addDaysLocal(date, 1))}>›</Button>
            <Button variant={date === today ? "primary" : "ghost"} className="px-3 py-2" onClick={() => setDate(today)}>{L.today}</Button>
            <Button variant={date === addDaysLocal(today, 1) ? "primary" : "ghost"} className="px-3 py-2" onClick={() => setDate(addDaysLocal(today, 1))}>{L.tomorrow}</Button>
          </div>
          <FilterSelect label={L.airport} value={airport} onChange={setAirport} options={[["EZE", "EZE"], ["AEP", "AEP"]]} />
          <FilterSelect label={L.state} value={state} onChange={setState} options={Object.entries(STATE_ES)} />
          <FilterSelect label={L.driver} value={driverId} onChange={setDriverId} options={[["none", L.unassigned], ...drivers.map((d) => [d.id, d.fullName] as [string, string])]} />
          <FilterSelect label={L.payment} value={pay} onChange={setPay} options={Object.entries(PAY_ES)} />
          <div className="w-64"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.search} className="py-2" aria-label="Buscar" /></div>
          <span className="ml-auto text-xs text-ink-400">
            {loading ? "Actualizando…" : loadedAt ? `Actualizado ${fmtTime(loadedAt.toISOString())}` : ""}
          </span>
        </div>
      </header>

      <div className="px-5 py-5">
        <div className="mb-4 empty:hidden"><CallDesk onOpenChat={() => setTab("whatsapp")} /></div>
        {calls.err && <p role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-300">{calls.err}</p>}
        <div className={cx("mb-4 flex flex-wrap items-center gap-x-6 gap-y-2", ["whatsapp", "flights", "drivers", "accounts", "reports"].includes(tab) && "hidden")}>
          <h1 className="text-lg font-semibold first-letter:uppercase">{fmtLocalDate(date)}</h1>
          <Stat n={counts.total} label="viajes" />
          <Stat n={counts.needs} label="sin chofer" tone="text-amber-300" />
          <Stat n={rows.filter((r) => r.onBoard).length} label="en la bolsa" tone="text-sky-300" />
          <Stat n={counts.held} label="en hold" tone="text-sky-300" />
          <Stat n={counts.confirmed} label="confirmados" tone="text-emerald-300" />
          {atDesk > 0 && <Link to="/central" className="hover:underline"><Stat n={atDesk} label="esperando en la central" tone="text-cab-300" /></Link>}
        </div>

        {error && <p role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">No se pudieron cargar las reservas: {error}</p>}

        {alerts.length > 0 && tab !== "whatsapp" && tab !== "flights" && (
          <div className="mb-5 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">{L.alerts} · {alerts.length}</div>
            <div className="flex flex-wrap gap-2">
              {alerts.map((a, i) => (
                <button key={i} onClick={() => setSelected(a.row)} className="text-left"><Badge tone={a.tone}>{a.text}</Badge></button>
              ))}
            </div>
          </div>
        )}

        {tab === "schedule" && <Schedule date={date} turnaround={turnaround} rows={filtered} drivers={drivers.filter((d) => d.approvalStatus === "approved" && d.active)} onSelect={setSelected} />}
        {tab === "map" && <MapPanel board={board} rows={rows} onSelectBooking={setSelected} />}
        {tab === "bookings" && <BookingsGrid rows={filtered} onSelect={setSelected} />}
        {tab === "flights" && <FlightsPanel />}
        {tab === "drivers" && <DriversAdmin />}
        {tab === "accounts" && <AccountsPanel />}
        {tab === "reports" && <ReportsPanel />}
        {tab === "whatsapp" && <WhatsAppConnection />}
        {tab === "whatsapp" && <WhatsAppInbox onCount={setWaPending} onOpenBooking={(ref) => {
          const r = rows.find((x) => x.reference === ref);
          if (r) setSelected(r); else { setQ(ref); setTab("bookings"); }
        }} />}
      </div>

      {selected && <BookingDrawer row={selected} drivers={drivers} board={board} onChanged={load} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** WhatsApp message from dispatch to this booking's passenger. Replies land in the WhatsApp tab, handled by whoever sent it. */
function PassengerMessage({ r, onClose }: { r: DispatchRow; onClose: () => void }) {
  const first = r.passengerName.split(" ")[0];
  const quick = [
    `Hola ${first}, tu chofer ya está en camino.`,
    `Hola ${first}, tu chofer llegó al punto de encuentro.`,
    `Hola ${first}, vimos que tu vuelo viene demorado: ajustamos la búsqueda, no te preocupes.`,
    `Hola ${first}, ¿nos confirmás la dirección exacta de búsqueda?`,
  ];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    const t = text.trim(); if (!t) return;
    setBusy(true); setErr(null); setDone(null);
    try {
      const res = await backend.waMessageBooking(r.id, t);
      // The passenger's answer should reach a person, not the bot.
      await backend.waTakeover(res.conversationId, true).catch(() => {});
      setDone(res.mode === "template" ? "Enviado como mensaje oficial (el pasajero no escribió en las últimas 24 h)." : "Enviado por WhatsApp.");
      setText("");
    } catch (e) {
      setErr(e instanceof CommandError ? (e.message && e.message !== e.code ? e.message : ERR_ES[e.code] ?? e.code) : (e as Error).message);
    } finally { setBusy(false); }
  }
  return (
    <section className="mt-4 rounded-2xl border border-cab-500/30 bg-ink-900 p-4" data-testid="passenger-message">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">💬 WhatsApp a {r.passengerName}</h3>
        <span className="text-xs text-ink-400">{r.passengerPhone}</span>
        <button onClick={onClose} className="ml-auto text-xs text-ink-400 hover:text-white">Cerrar</button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {quick.map((q) => <button key={q} onClick={() => setText(q)} className="rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-200 hover:bg-ink-700">{q.replace(/^Hola [^,]+, /, "")}</button>)}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={900} rows={3} placeholder="Escribí el mensaje…"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-cab-500 focus:outline-none" data-testid="passenger-message-text" />
      <div className="mt-2 flex items-center gap-3">
        <Button onClick={send} disabled={busy || !text.trim()} className="py-2" data-testid="passenger-message-send">{busy ? "Enviando…" : "Enviar"}</Button>
        <span className="text-[11px] text-ink-400">La respuesta del pasajero llega a la pestaña WhatsApp, a tu nombre.</span>
      </div>
      {done && <p className="mt-2 text-sm text-emerald-300" role="status">✓ {done}</p>}
      {err && <p className="mt-2 text-sm text-red-300" role="alert">{err}</p>}
    </section>
  );
}

function Stat({ n, label, tone = "text-white" }: { n: number; label: string; tone?: string }) {
  return <span className="text-sm text-ink-400"><span className={cx("mr-1 text-lg font-semibold tabular-nums", tone)}>{n}</span>{label}</span>;
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="w-48">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="py-2 pr-9">
        <option value="">{label}: {L.all}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </div>
  );
}

// ------------------------------------------------------------------------- schedule (timeline)
const HOUR_PX = 64;

function Schedule({ date, turnaround, rows, drivers, onSelect }: { date: string; turnaround: number; rows: DispatchRow[]; drivers: Driver[]; onSelect: (r: DispatchRow) => void }) {
  const dayStart = localToUtc(date, "00:00").getTime();
  const active = rows.filter((r) => r.state !== "cancelled");
  const unassigned = active.filter((r) => !r.driverId);
  const lanes = useMemo(() => {
    // Greedy lane packing so overlapping unassigned jobs stay readable.
    const sorted = [...unassigned].sort((a, b) => a.agreedPickupAt.localeCompare(b.agreedPickupAt));
    const ends: number[] = [];
    return sorted.map((r) => {
      const s = new Date(r.agreedPickupAt).getTime();
      let lane = ends.findIndex((e) => e <= s);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = s + (r.estDurationMin + turnaround) * 60_000;
      return { r, lane };
    });
  }, [unassigned, turnaround]);
  const laneCount = Math.max(1, ...lanes.map((l) => l.lane + 1));
  const now = Date.now();
  const nowX = now >= dayStart && now < dayStart + 86_400_000 ? ((now - dayStart) / 3_600_000) * HOUR_PX : null;

  const block = (r: DispatchRow, top: number) => {
    const s = (new Date(r.agreedPickupAt).getTime() - dayStart) / 3_600_000;
    const w = Math.max(((r.estDurationMin + turnaround) / 60) * HOUR_PX, 96);
    const dirIcon = r.direction === "from_airport" ? `${r.airport} →` : `→ ${r.airport}`;
    return (
      <button key={r.id} onClick={() => onSelect(r)} data-testid={`block-${r.reference}`}
        style={{ left: s * HOUR_PX, width: w, top }}
        className={cx("absolute h-[52px] overflow-hidden rounded-lg border px-2 py-1 text-left text-[11px] leading-tight shadow transition hover:z-10 hover:brightness-125",
          r.state === "needs_driver" && "border-amber-500/50 bg-amber-500/15",
          r.state === "held" && "border-dashed border-sky-400/60 bg-sky-500/15",
          r.state === "confirmed" && "border-emerald-500/40 bg-emerald-500/15")}>
        <div className="flex items-center gap-1 font-semibold text-white"><span className="tabular-nums">{fmtTime(r.agreedPickupAt)}</span><span className="text-ink-300">{dirIcon}</span></div>
        <div className="truncate text-ink-300">{r.zoneName} · {VC_ES[r.vehicleClass]} · {r.passengers}p</div>
        <div className="truncate font-mono text-ink-400">{r.reference}{r.flightDesignator ? ` · ${r.flightDesignator}` : ""}</div>
      </button>
    );
  };

  const Row = ({ label, sub, height, children }: { label: string; sub?: string; height: number; children: React.ReactNode }) => (
    <div className="flex border-b border-ink-800">
      <div className="sticky left-0 z-20 w-48 shrink-0 border-r border-ink-800 bg-ink-950 px-3 py-2" style={{ height }}>
        <div className="truncate text-sm font-medium">{label}</div>
        {sub && <div className="truncate text-xs text-ink-400">{sub}</div>}
      </div>
      <div className="relative" style={{ width: 24 * HOUR_PX, height }}>
        {Array.from({ length: 24 }, (_, h) => <div key={h} className={cx("absolute top-0 h-full border-l", h % 6 === 0 ? "border-ink-700" : "border-ink-800/70")} style={{ left: h * HOUR_PX }} />)}
        {nowX !== null && <div className="absolute top-0 z-10 h-full w-px bg-cab-500" style={{ left: nowX }} />}
        {children}
      </div>
    </div>
  );

  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-800 bg-ink-950" data-testid="schedule">
      <div className="min-w-max">
        <div className="flex border-b border-ink-800 bg-ink-900">
          <div className="sticky left-0 z-20 w-48 shrink-0 border-r border-ink-800 bg-ink-900 px-3 py-2 text-xs text-ink-400">Chofer / vehículo</div>
          <div className="relative h-8" style={{ width: 24 * HOUR_PX }}>
            {Array.from({ length: 24 }, (_, h) => <span key={h} className={cx("absolute top-2 text-[10px] tabular-nums text-ink-400", h > 0 && "-translate-x-1/2")} style={{ left: h === 0 ? 4 : h * HOUR_PX }}>{String(h).padStart(2, "0")}:00</span>)}
          </div>
        </div>
        <Row label={L.unassigned} sub={`${unassigned.length} viaje(s)`} height={laneCount * 60 + 8}>
          {lanes.map(({ r, lane }) => block(r, 4 + lane * 60))}
        </Row>
        {drivers.map((d) => {
          const mine = active.filter((r) => r.driverId === d.id);
          return (
            <Row key={d.id} label={d.fullName} sub={mine[0]?.vehiclePlate ?? undefined} height={60}>
              {mine.map((r) => block(r, 4))}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- map
function MapPanel({ board, rows, onSelectBooking }: { board: BoardRow[]; rows: DispatchRow[]; onSelectBooking: (r: DispatchRow) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const counts = (["free", "to_pickup", "onboard", "stale", "off"] as const).map((k) => [k, board.filter((b) => b.mapStatus === k).length] as const);
  const order = { to_pickup: 0, onboard: 1, free: 2, stale: 3, off: 4 } as const;
  const list = [...board].sort((a, b) => order[a.mapStatus] - order[b.mapStatus] || a.fullName.localeCompare(b.fullName));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div>
        <DriverMap rows={board} selectedId={sel} onSelect={setSel} height={600} />
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-300">
          {counts.map(([k, n]) => (
            <span key={k} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[k] }} />{STATUS_ES[k]} · {n}</span>
          ))}
          <span className="ml-auto text-ink-500">Ubicación cada ~15 s con la app del chofer abierta. Sin señal = sin datos hace más de 2 min.</span>
        </div>
      </div>
      <div className="max-h-[640px] overflow-y-auto rounded-2xl border border-ink-800">
        {list.map((b) => {
          const job = b.currentReference ? rows.find((r) => r.reference === b.currentReference) : rows.find((r) => r.driverId === b.driverId && r.state !== "cancelled" && r.state !== "closed");
          return (
            <button key={b.driverId} onClick={() => setSel(b.driverId)}
              className={cx("block w-full border-b border-ink-800 px-4 py-3 text-left hover:bg-ink-900", sel === b.driverId && "bg-ink-900")}>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[b.mapStatus] }} />
                <span className="flex-1 truncate font-medium">{b.fullName}</span>
                <span className="text-[11px] text-ink-400">{STATUS_ES[b.mapStatus]}</span>
              </div>
              <div className="mt-0.5 pl-4 text-xs text-ink-400">
                {b.vehiclePlate ?? "sin vehículo"}{b.recordedAt ? ` · visto ${fmtTime(b.recordedAt)}` : ""}
              </div>
              {job && (
                <span role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); onSelectBooking(job); }}
                  className="mt-1 ml-4 inline-block rounded bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-cab-400 hover:bg-ink-700">
                  {job.reference} · {fmtTime(job.agreedPickupAt)}
                </span>
              )}
            </button>
          );
        })}
        {!list.length && <p className="p-6 text-sm text-ink-400">Sin choferes.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- grid
function BookingsGrid({ rows, onSelect }: { rows: DispatchRow[]; onSelect: (r: DispatchRow) => void }) {
  if (!rows.length) return <p className="rounded-2xl border border-ink-800 p-10 text-center text-ink-400">{L.none}</p>;
  const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400";
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-800">
      <table className="w-full min-w-[1000px] text-sm" data-testid="bookings-grid">
        <thead className="bg-ink-900"><tr>
          <th className={th}>{L.pickup}</th><th className={th}>{L.ref}</th><th className={th}>{L.state}</th><th className={th}>{L.trip}</th>
          <th className={th}>{L.flight}</th><th className={th}>{L.vehicle}</th><th className={th}>{L.passenger}</th><th className={th}>{L.driver}</th><th className={cx(th, "text-right")}>{L.money}</th>
        </tr></thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((r) => (
            <tr key={r.id} onClick={() => onSelect(r)} className={cx("cursor-pointer hover:bg-ink-900", r.state === "cancelled" && "opacity-50")}>
              <td className="px-3 py-2.5 font-semibold tabular-nums">{fmtTime(r.agreedPickupAt)}</td>
              <td className="px-3 py-2.5 font-mono text-xs">{r.reference}</td>
              <td className="px-3 py-2.5"><Badge tone={r.state}>{STATE_ES[r.state]}</Badge>
                {(() => { const bl = boardLabel(r); return bl && r.state === "needs_driver" ? <div className="mt-1"><Badge tone={bl.tone}>{bl.text}</Badge></div> : null; })()}</td>
              <td className="px-3 py-2.5">
                <span className="font-mono text-xs text-ink-300">{r.direction === "from_airport" ? `${r.airport} → ` : ""}</span>
                {r.zoneName}
                <span className="font-mono text-xs text-ink-300">{r.direction === "to_airport" ? ` → ${r.airport}` : ""}</span>
              </td>
              <td className="px-3 py-2.5 font-mono text-xs">{r.flightDesignator ?? (r.flightExceptionReason ? <Badge tone="warn">excepción</Badge> : "—")}</td>
              <td className="px-3 py-2.5">{VC_ES[r.vehicleClass]} <span className="text-xs text-ink-400">· {r.passengers}p {r.largeBags}v {r.carryOn}m</span></td>
              <td className="px-3 py-2.5">{r.passengerName}</td>
              <td className="px-3 py-2.5">{r.driverName ?? <span className="text-ink-500">—</span>}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {r.amountMinor !== null ? formatMoney(r.amountMinor, r.currency!, "es-AR") : "—"}
                <div className="text-[11px] text-ink-400">{PAY_ES[r.paymentMode]} {COLLECT_ES[r.collectionState] && `· ${COLLECT_ES[r.collectionState]}`}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------------- detail drawer
const ERR_ES: Record<string, string> = {
  no_phone: "La reserva no tiene teléfono.", template_not_approved: "La plantilla de mensajes todavía no está aprobada por Meta.",
  template_missing: "Falta la plantilla de mensajes.", whatsapp_not_configured: "WhatsApp no está conectado.",
  stale_version: "La reserva cambió mientras la mirabas. Se actualizó; revisá y probá de nuevo.",
  schedule_conflict: "Ese chofer o vehículo ya tiene un viaje que se superpone.",
  already_assigned: "La reserva ya tiene chofer.", vehicle_too_small: "El vehículo no alcanza para pasajeros o equipaje.",
  outside_working_hours: "El chofer no trabaja a esa hora (turno o indisponibilidad).", no_vehicle_allocated: "El chofer no tiene vehículo asignado para ese horario.",
  vehicle_not_allocated_to_driver: "Ese vehículo no está asignado al chofer.", driver_not_approved: "Chofer no aprobado o inactivo.",
  no_eligible_drivers: "No hay choferes libres y habilitados para este viaje.", booking_not_open: "Solo se ofrecen reservas sin chofer.",
  reason_required: "Indicá un motivo.", booking_closed: "La reserva ya está cerrada o cancelada.", no_active_driver: "La reserva no tiene chofer activo.",
  forbidden: "Tu usuario no tiene permiso para esto.", driver_conflict: "El chofer tiene otro viaje a ese horario.",
  no_proposal: "Ya no hay un cambio sugerido.", invalid_amount: "Monto inválido (no puede superar lo cobrado sin reembolsar).",
  already_paid: "El pasajero ya pagó este viaje.", already_invoiced: "El viaje ya está en una factura de la cuenta.", account_not_found: "Cuenta inexistente o inactiva.",
  documents_missing: "Al chofer o a su vehículo le falta documentación obligatoria (ver Choferes → Documentación).",
  documents_expired: "La documentación del chofer o del vehículo estará vencida en la fecha del viaje.",
  no_payment: "No hay un pago aprobado para reembolsar.", invalid_settings: "Revisá la moneda y el tipo de cambio.", live_only: "Disponible solo en modo en vivo (con Supabase).",
};
function boardLabel(r: DispatchRow): { tone: string; text: string } | null {
  if (r.state !== "needs_driver") return r.claimSource === "board" ? { tone: "neutral", text: "Tomado de la bolsa" } : null;
  if (r.boardHold) return { tone: "neutral", text: "Retenido por despacho" };
  if (r.autoDispatch) return { tone: "warn", text: `Oferta automática · ronda ${r.autoRounds}${r.openOffers ? ` · ${r.openOffers} abierta(s)` : ""}` };
  if (r.onBoard) return { tone: "held", text: "En la bolsa" };
  if (r.openOffers) return { tone: "warn", text: `Ofertado · ${r.openOffers} abierta(s)` };
  return { tone: "needs_driver", text: "Sin publicar" };
}

const errText = (e: unknown) => (e instanceof CommandError ? ERR_ES[e.code] ?? e.message : (e as Error).message);

function BookingActions({ r, drivers, board, onChanged }: { r: DispatchRow; drivers: Driver[]; board: BoardRow[]; onChanged: () => void }) {
  const [driverId, setDriverId] = useState("");
  const [group, setGroup] = useState(3);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const open = r.state === "needs_driver";
  const covered = r.state === "held" || r.state === "confirmed";
  const ended = r.state === "cancelled" || r.state === "closed";
  const approved = drivers.filter((d) => d.approvalStatus === "approved" && d.active);
  const status = (id: string) => board.find((b) => b.driverId === id);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); setReason(""); onChanged(); }
    catch (e) { setMsg({ ok: false, text: errText(e) }); if (e instanceof CommandError && e.code === "stale_version") onChanged(); }
    finally { setBusy(false); }
  }

  if (ended) return null;
  return (
    <div className="mt-5 space-y-3 rounded-xl border border-ink-700 bg-ink-800/40 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Acciones</div>
      <div className="flex gap-2">
        <div className="flex-1">
          <Select value={driverId} onChange={(e) => setDriverId(e.target.value)} className="py-2" aria-label="Chofer">
            <option value="">{covered ? "Reasignar a…" : "Asignar a…"}</option>
            {approved.filter((d) => d.id !== r.driverId).map((d) => {
              const b = status(d.id);
              return <option key={d.id} value={d.id}>{d.fullName}{b ? ` · ${STATUS_ES[b.mapStatus]}` : ""}</option>;
            })}
          </Select>
        </div>
        <Button className="py-2" disabled={!driverId || busy || (covered && !reason.trim())}
          onClick={() => run(() => backend.assign(r.id, driverId, r.version, covered ? reason : undefined), covered ? "Chofer reasignado." : "Chofer asignado.")}>
          {covered ? "Reasignar" : "Asignar"}
        </Button>
      </div>
      {open && (
        <div className="flex flex-wrap gap-2">
          {r.boardHold || !r.onBoard
            ? <Button variant="outline" className="py-2 text-xs" disabled={busy} onClick={() => run(() => backend.boardAction(r.id, "publish", r.version), "Publicado en la bolsa.")}>Publicar en la bolsa</Button>
            : <Button variant="outline" className="py-2 text-xs" disabled={busy} onClick={() => run(() => backend.boardAction(r.id, "hold", r.version), "Retenido fuera de la bolsa.")}>Retener (sacar de la bolsa)</Button>}
          {!r.autoDispatch && <Button variant="outline" className="py-2 text-xs" disabled={busy} onClick={() => run(() => backend.boardAction(r.id, "auto", r.version), "Ofreciendo automáticamente a los más cercanos.")}>Oferta automática (más cercanos)</Button>}
          {r.autoDispatch && <Button variant="outline" className="py-2 text-xs" disabled={busy} onClick={() => run(() => backend.boardAction(r.id, "hold", r.version), "Oferta automática detenida.")}>Detener oferta automática</Button>}
        </div>
      )}
      {open && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-300">Ofrecer a los</span>
          <div className="w-20"><Input type="number" min={1} max={10} value={group} onChange={(e) => setGroup(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="py-2" aria-label="Cantidad" /></div>
          <span className="flex-1 text-sm text-ink-300">más cercanos</span>
          <Button variant="outline" className="py-2" disabled={busy}
            onClick={() => run(async () => { const o = await backend.offer(r.id, r.version, group); setMsg({ ok: true, text: `Oferta enviada a ${o.offered}` }); }, "Oferta enviada.")}>Ofrecer</Button>
        </div>
      )}
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={covered ? "Motivo (obligatorio para reasignar, liberar o cancelar)" : "Motivo (para cancelar)"} className="py-2" aria-label="Motivo" />
      <div className="flex gap-2">
        {covered && <Button variant="outline" className="flex-1 py-2" disabled={busy || !reason.trim()} onClick={() => run(() => backend.release(r.id, r.version, reason), "Chofer liberado; la reserva vuelve a la cola.")}>Liberar chofer</Button>}
        <Button variant="outline" className="flex-1 border-red-500/40 py-2 text-red-300" disabled={busy || !reason.trim()} onClick={() => run(() => backend.cancel(r.id, r.version, reason), "Reserva cancelada.")}>Cancelar reserva</Button>
      </div>
      {msg && <p role="status" className={cx("text-sm", msg.ok ? "text-emerald-300" : "text-red-300")}>{msg.text}</p>}
    </div>
  );
}

function BookingDrawer({ row: r, drivers, board, onChanged, onClose }: { row: DispatchRow; drivers: Driver[]; board: BoardRow[]; onChanged: () => void; onClose: () => void }) {
  const [events, setEvents] = useState<TripEvent[]>([]);
  const [msgOpen, setMsgOpen] = useState(false);
  useEffect(() => { setMsgOpen(false); }, [r.id]);
  useEffect(() => { backend.tripEvents(r.id).then(setEvents).catch(() => setEvents([])); }, [r.id, r.version, r.state]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const mapsUrl = (label: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label + ", Buenos Aires")}`;
  const item = "grid grid-cols-[110px_1fr] gap-3 py-2";
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Reserva ${r.reference}`}>
      <aside className="h-full w-full max-w-md overflow-y-auto border-l border-ink-700 bg-ink-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <div className="font-mono text-xl font-bold text-cab-400">{r.reference}</div>
            <div className="mt-1 flex flex-wrap gap-2"><Badge tone={r.state}>{STATE_ES[r.state]}</Badge><Badge>{SOURCE_ES[r.source]}</Badge>{r.locale === "en" && <Badge>EN</Badge>}
              {(() => { const bl = boardLabel(r); return bl ? <Badge tone={bl.tone}>{bl.text}</Badge> : null; })()}</div>
          </div>
          <button onClick={onClose} className="text-2xl text-ink-400 hover:text-white" aria-label="Cerrar">×</button>
        </div>

        <dl className="mt-5 divide-y divide-ink-800 text-sm">
          <div className={item}><dt className="text-ink-400">{L.pickup}</dt><dd className="font-semibold">{fmtDateTime(r.agreedPickupAt)}{r.proposedPickupAt && <span className="ml-2 text-amber-300">→ {fmtTime(r.proposedPickupAt)}?</span>}</dd></div>
          <div className={item}><dt className="text-ink-400">Desde</dt><dd>{r.pickupPlace.label} <a className="ml-1 text-xs text-cab-400" href={mapsUrl(r.pickupPlace.label)} target="_blank" rel="noreferrer">mapa</a>
            {(r.pickupPlace as { kind?: string }).kind !== "airport" && r.pickupPlace.originalText && r.pickupPlace.originalText !== r.pickupPlace.label && <div className="text-xs text-ink-400">Texto original: “{r.pickupPlace.originalText}”</div>}</dd></div>
          <div className={item}><dt className="text-ink-400">Hasta</dt><dd>{r.dropoffPlace.label} <a className="ml-1 text-xs text-cab-400" href={mapsUrl(r.dropoffPlace.label)} target="_blank" rel="noreferrer">mapa</a></dd></div>
          <div className={item}><dt className="text-ink-400">{L.flight}</dt><dd><span className="font-mono">{r.flightDesignator ? `${r.flightDesignator} · llegada ${r.flightLocalArrivalDate}` : r.flightExceptionReason ? `Excepción: ${r.flightExceptionReason}` : "—"}</span>
            {r.flightDesignator && <FlightLine r={r} />}</dd></div>
          <div className={item}><dt className="text-ink-400">{L.vehicle}</dt><dd>{VC_ES[r.vehicleClass]} · {r.passengers} pax · {r.largeBags} valijas · {r.carryOn} mano</dd></div>
          <div className={item}><dt className="text-ink-400">{L.passenger}</dt><dd>
            {r.passengerPhone ? (
              <button onClick={() => setMsgOpen((o) => !o)} className="text-left font-medium text-cab-300 underline decoration-dotted underline-offset-4 hover:text-cab-200" data-testid="passenger-message-open" title="Mandar un WhatsApp al pasajero">
                {r.passengerName} 💬
              </button>
            ) : r.passengerName}
            <div className="text-xs text-ink-300">{[r.passengerPhone, r.passengerEmail].filter(Boolean).join(" · ")}</div></dd></div>
          <div className={item}><dt className="text-ink-400">{L.money}</dt><dd>{r.amountMinor !== null ? formatMoney(r.amountMinor, r.currency!, "es-AR") : "—"} · {PAY_ES[r.paymentMode]} ({COLLECT_ES[r.collectionState] || "—"})</dd></div>
          <div className={item}><dt className="text-ink-400">{L.driver}</dt><dd>{r.driverName ? `${r.driverName} · ${r.vehiclePlate}` : "Sin asignar"}{r.holdExpiresAt && <div className="text-xs text-sky-300">Hold hasta {fmtTime(r.holdExpiresAt)}</div>}</dd></div>
          {r.notes && <div className={item}><dt className="text-ink-400">{L.notes}</dt><dd>{r.notes}</dd></div>}
        </dl>

        {msgOpen && r.passengerPhone && <PassengerMessage r={r} onClose={() => setMsgOpen(false)} />}
        {r.proposedPickupAt && <PickupProposal r={r} onChanged={onChanged} />}
        <PaymentBox r={r} onChanged={onChanged} />
        <AccountBox r={r} onChanged={onChanged} />
        <BookingActions r={r} drivers={drivers} board={board} onChanged={onChanged} />

        <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-ink-400">{L.timeline}</h3>
        <ol className="relative ml-2 border-l border-ink-700">
          {events.map((e, i) => (
            <li key={i} className="mb-4 ml-4">
              <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-ink-900 bg-cab-500" />
              <div className="text-xs text-ink-400">{fmtDateTime(e.at)} · {e.actor}</div>
              <div className="text-sm">{e.kind === "booking.created" ? "Reserva creada"
                : e.kind === "booking.offered" ? `Ofrecida a ${String(e.payload?.drivers ?? "")} chofer(es)`
                : e.kind === "offer.declined" ? "Oferta rechazada"
                : e.kind === "assignment.released" ? "Chofer liberado"
                : e.kind === "trip.stage_changed" ? `Viaje: ${STAGE_ES[e.toValue ?? ""] ?? e.toValue}`
                : `${STATE_ES[e.fromValue ?? ""] ?? e.fromValue} → ${STATE_ES[e.toValue ?? ""] ?? e.toValue}`}
                {typeof e.payload?.driver === "string" && <span className="text-ink-300"> · {e.payload.driver}</span>}
                {typeof e.payload?.reason === "string" && <span className="text-ink-300"> · {e.payload.reason}</span>}</div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

const FLIGHT_ES: Record<string, string> = {
  scheduled: "programado", delayed: "demorado", boarding: "embarcando", departed: "despegó", en_route: "en vuelo",
  approaching: "aproximando", landed: "aterrizó", cancelled: "CANCELADO", diverted: "DESVIADO", unknown: "sin datos",
};
const REVIEW_ES: Record<string, string> = {
  flight_cancelled: "vuelo cancelado", flight_diverted: "vuelo desviado", different_airport: "llega a otro aeropuerto", ambiguous_flight: "vuelo ambiguo (varios)",
};

function FlightLine({ r }: { r: DispatchRow }) {
  if (!r.flightCheckedAt) return <div className="text-xs text-ink-500">Sin seguimiento todavía (empieza 24 h antes)</div>;
  const stale = Date.now() - new Date(r.flightCheckedAt).getTime() > 45 * 60_000;
  return (
    <div className="mt-0.5 text-xs">
      <span className={cx("font-semibold", r.flightStatus === "delayed" ? "text-amber-300" : r.flightStatus === "cancelled" || r.flightStatus === "diverted" ? "text-red-300" : "text-emerald-300")}>
        {FLIGHT_ES[r.flightStatus ?? "unknown"] ?? r.flightStatus}</span>
      {r.flightEstimatedArrivalAt && <> · llega {fmtTime(r.flightEstimatedArrivalAt)}{r.flightEstimateKind === "runway_plus_taxi" ? " (pista + rodaje, estimado)" : r.flightEstimateKind === "scheduled" ? " (programado)" : ""}</>}
      <span className={cx("ml-1", stale ? "text-red-300" : "text-ink-500")}>· {stale ? "datos viejos, " : ""}verificado {fmtTime(r.flightCheckedAt)}</span>
      {r.flightReviewReason && <div className="font-semibold text-red-300">⚠ Revisar: {REVIEW_ES[r.flightReviewReason] ?? r.flightReviewReason}</div>}
    </div>
  );
}

function WhatsAppConnection() {
  const [open, setOpen] = useState(false);
  return open ? <WhatsAppSetup /> : (
    <div className="mb-3 flex justify-end"><Button variant="ghost" className="py-1.5 text-sm" onClick={() => setOpen(true)} data-testid="wa-setup-open">⚙️ Conexión de WhatsApp</Button></div>
  );
}

/** Bill the trip to a hotel/agency account instead of charging the passenger. */
function AccountBox({ r, onChanged }: { r: DispatchRow; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[] | null>(null);
  const [pick, setPick] = useState(r.accountId ?? "");
  const [ref, setRef] = useState(r.accountRef ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const editable = r.state !== "closed" && r.state !== "cancelled" && r.collectionState !== "collected";
  useEffect(() => { backend.accounts().then((a) => setAccounts(a.filter((x) => x.active)), () => setAccounts([])); }, []);
  if (!r.accountId && (!editable || !accounts?.length)) return null;
  return (
    <section className="mt-4 rounded-xl border border-ink-800 p-3 text-sm" data-testid="account-box">
      <div className="text-xs uppercase tracking-wide text-ink-400">Facturar a cuenta</div>
      {r.accountId && <p className="mt-1 text-white">🏨 {r.accountName}{r.accountRef && <span className="text-ink-400"> · {r.accountRef}</span>}</p>}
      {editable && accounts && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} className="w-56 py-2" aria-label="Cuenta">
            <option value="">— Paga el pasajero —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} placeholder="Huésped / habitación / voucher" className="w-52 py-2" />
          <Button variant="outline" className="py-2" onClick={async () => {
            setMsg(null);
            try { await backend.setBookingAccount(r.id, r.version, pick || null, ref || null); onChanged(); setMsg(pick ? "Se factura a la cuenta ✓" : "Vuelve a pagar el pasajero ✓"); }
            catch (e) { setMsg(errText(e)); }
          }}>Guardar</Button>
        </div>
      )}
      {msg && <p className="mt-1 text-xs text-ink-300">{msg}</p>}
    </section>
  );
}

function PickupProposal({ r, onChanged }: { r: DispatchRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const shift = Math.round((new Date(r.proposedPickupAt!).getTime() - new Date(r.agreedPickupAt).getTime()) / 60000);
  async function decide(approve: boolean, release = false) {
    setBusy(true); setMsg(null);
    try {
      const res = await backend.decidePickup(r.id, r.version, approve, release);
      setMsg(approve ? (res.releasedDriver ? "Horario cambiado; el chofer quedó libre y el viaje vuelve a buscar chofer." : "Horario cambiado. Avisamos al pasajero y al chofer.") : "Sugerencia descartada.");
      setConflict(false); onChanged();
    } catch (e) {
      if (e instanceof CommandError && e.code === "driver_conflict") setConflict(true);
      else setMsg(errText(e));
    } finally { setBusy(false); }
  }
  return (
    <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="pickup-proposal">
      <div className="font-semibold text-amber-200">🕒 Cambio de horario sugerido por el vuelo</div>
      <p className="mt-1 text-ink-200">
        {r.flightDesignator} llega {r.flightEstimatedArrivalAt ? fmtTime(r.flightEstimatedArrivalAt) : "—"}. Búsqueda sugerida <b>{fmtTime(r.proposedPickupAt!)}</b>
        {" "}(acordada {fmtTime(r.agreedPickupAt)}, {shift > 0 ? "+" : ""}{shift} min).
      </p>
      {conflict ? (
        <div className="mt-2 space-y-2">
          <p className="text-red-200">El chofer tiene otro viaje a ese horario.</p>
          <div className="flex gap-2">
            <Button className="py-1.5 text-sm" disabled={busy} onClick={() => decide(true, true)}>Cambiar horario y liberar chofer</Button>
            <Button variant="outline" className="py-1.5 text-sm" disabled={busy} onClick={() => setConflict(false)}>Volver</Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button className="py-1.5 text-sm" disabled={busy} onClick={() => decide(true)}>Aprobar y avisar</Button>
          <Button variant="outline" className="py-1.5 text-sm" disabled={busy} onClick={() => decide(false)}>Descartar</Button>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-ink-200" role="status">{msg}</p>}
    </div>
  );
}

function PaymentBox({ r, onChanged }: { r: DispatchRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!r.paidMinor && !r.paymentReview) return null;
  const cur = r.paidCurrency ?? r.currency ?? "ARS";
  const left = r.paidMinor - r.refundedMinor;
  async function submit() {
    const minor = Math.round(Number(amount.replace(",", ".")) * 100);
    setBusy(true); setMsg(null);
    try { await backend.refund(r.id, minor, reason); setMsg("Reembolso pedido a Mercado Pago."); setOpen(false); setReason(""); onChanged(); }
    catch (e) { setMsg(errText(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/40 p-3 text-sm" data-testid="payment-box">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Pago Mercado Pago</span>
        {r.paymentReview && <Badge tone="cancelled">revisar</Badge>}
      </div>
      <p className="mt-1">Cobrado <b>{formatMoney(r.paidMinor, cur, "es-AR")}</b>{r.refundedMinor > 0 && <> · reembolsado {formatMoney(r.refundedMinor, cur, "es-AR")}</>}</p>
      {r.paymentReview && <p className="mt-1 text-xs text-red-200">Hay un pago para conciliar (pago extra, monto distinto o reserva sin chofer/cancelada). Ver alertas.</p>}
      {left > 0 && !open && <Button variant="outline" className="mt-2 py-1 text-xs" onClick={() => { setOpen(true); setAmount((left / 100).toFixed(2)); }}>Reembolsar…</Button>}
      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Monto a reembolsar"
              className="w-32 rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-white" />
            <span className="self-center text-xs text-ink-400">{cur} · máx {(left / 100).toFixed(2)}</span>
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo"
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-white" />
          <div className="flex gap-2">
            <Button className="py-1 text-xs" disabled={busy || !reason.trim() || !amount} onClick={submit}>Confirmar reembolso</Button>
            <Button variant="outline" className="py-1 text-xs" onClick={() => setOpen(false)}>Cancelar</Button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-ink-200" role="status">{msg}</p>}
    </div>
  );
}

function PaymentSettingsButton() {
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("ARS");
  const [usd, setUsd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    backend.paymentSettings().then((p) => { setCurrency(p.currency); setUsd(p.fx.USD ? String(p.fx.USD) : ""); }).catch(() => {});
  }, [open]);
  return (
    <>
      <button onClick={() => setOpen(true)} className="text-ink-300 hover:text-white">Cobros</button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Cobros">
          <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Cobros con Mercado Pago</h2>
            <p className="mt-1 text-xs text-ink-400">Mercado Pago Argentina cobra en pesos. Las tarifas en dólares se convierten con este tipo de cambio al generar el link de pago (queda fijo en ese link).</p>
            <label className="mt-4 block text-xs text-ink-400">Moneda de cobro
              <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-white" /></label>
            <label className="mt-3 block text-xs text-ink-400">Pesos por 1 USD
              <input value={usd} onChange={(e) => setUsd(e.target.value)} inputMode="decimal" placeholder="ej. 1180" className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-2 py-1.5 text-white" /></label>
            <div className="mt-4 flex gap-2">
              <Button className="py-1.5 text-sm" onClick={async () => {
                setMsg(null);
                try { await backend.setPaymentSettings(currency, usd ? { USD: Number(usd.replace(",", ".")) } : {}); setMsg("Guardado."); }
                catch (e) { setMsg(errText(e)); }
              }}>Guardar</Button>
              <Button variant="outline" className="py-1.5 text-sm" onClick={() => setOpen(false)}>Cerrar</Button>
            </div>
            {msg && <p className="mt-2 text-xs text-ink-200">{msg}</p>}
            <p className="mt-3 text-[11px] text-ink-500">Solo administración y finanzas pueden cambiarlo.</p>
          </div>
        </div>
      )}
    </>
  );
}
