// Central de reservas (booking desk): where every booking arrives (web, WhatsApp bot, calls, staff),
// where agents answer WhatsApp calls and chats, take bookings by phone, and hand bookings to dispatch.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Logo } from "../components/ui";
import { CallPanel, useCalls } from "../components/CallPanel";
import { TransferCalls } from "../components/TransferCalls";
import { CallerHistory } from "../components/CallerHistory";
import { CallModeSwitch } from "../components/CallDesk";
import { WhatsAppInbox } from "../components/WhatsAppInbox";
import { NewBookingsBell } from "../components/NewBookings";
import { useNavigate } from "react-router-dom";
import { backend, CommandError, type CallMode, type CallSettings, type DeskMethod, type DeskMode, type DispatchRow, type PastCall, type StaffSession, type WaCall } from "../lib/backend";
import { cx, fmtDateTime, fmtTime, formatMoney } from "../lib/format";
import { StaffLangSwitch } from "../lib/staffLang";
import BookingPage from "./BookingPage";
import { StaffLogin } from "./DispatchPage";

const SOURCE: Record<string, { label: string; tone: string }> = {
  web: { label: "Web", tone: "held" }, whatsapp: { label: "WhatsApp", tone: "confirmed" }, staff: { label: "Staff", tone: "neutral" },
  phone: { label: "Llamada", tone: "warn" }, voice: { label: "🤖 Voz", tone: "held" },
};
const STATE: Record<string, string> = { requested: "Solicitada", needs_driver: "Sin chofer", held: "Reservada", confirmed: "Confirmada", closed: "Cerrada", cancelled: "Cancelada" };
const METHOD: Record<DeskMethod, { label: string; icon: string; help: string }> = {
  auto: { label: "Automático", icon: "⚡", help: "Se ofrece ya a los choferes más cercanos" },
  board: { label: "Bolsa", icon: "📋", help: "Los choferes lo toman de la bolsa (los urgentes se ofrecen solos)" },
  manual: { label: "Manual", icon: "👤", help: "Queda en despacho para que lo asigne un despachante" },
};
const ERR: Record<string, string> = {
  stale_version: "La reserva cambió mientras la mirabas; se recargó.", already_sent: "Esa reserva ya se envió a despacho.",
  forbidden: "Tu usuario no tiene permiso para la central.", no_eligible_drivers: "No hay choferes disponibles; despacho fue alertado.",
};
const L = { title: "Central de reservas" };

export default function CentralPage() {
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  useEffect(() => { backend.staffSession().then(setSession); }, []);
  if (session === undefined) return null;
  if (!session) return <StaffLogin onDone={setSession} title={L.title} />;
  return (
    <Central session={session} onSignOut={async () => { await backend.signOut(); setSession(null); }} />
  );
}

type Tab = "incoming" | "whatsapp" | "calls" | "new";

function Central({ session, onSignOut }: { session: StaffSession; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("incoming");
  const [mode, setMode] = useState<DeskMode>("auto");
  const [callMode, setCallModeState] = useState<CallSettings>({ mode: "desk", voiceId: null, ringSeconds: 20 });
  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [waPending, setWaPending] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newFor, setNewFor] = useState<{ key: string; name?: string; phone?: string; callId?: string } | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ call: WaCall; rows: DispatchRow[]; calls?: PastCall[] } | null>(null);
  const showHistory = async (c: WaCall) => {
    const [rows, calls] = await Promise.all([backend.callerHistory(c.phone), backend.callerCalls(c.phone).catch(() => [])]);
    setHistory({ call: c, rows, calls });
  };
  const { calls, reload: reloadCalls } = useCalls();
  // Answering a call opens the booking form for that caller, with their history, by itself (once per call).
  const myCall = calls.find((c) => (c.status === "active" || c.status === "answering") && c.answeredByMe) ?? null;
  const popped = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!myCall || popped.current.has(myCall.id)) return;
    popped.current.add(myCall.id);
    startBooking(myCall);
    showHistory(myCall);
  }, [myCall?.id]);

  const load = useCallback(async () => {
    try {
      const [m, r, c] = await Promise.all([backend.deskMode(), backend.deskRows(), backend.callMode()]);
      setMode(m); setRows(r); setCallModeState(c); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = backend.subscribe((table) => {
      if (!["bookings", "assignments", "desk_settings"].includes(table)) return;
      if (t) clearTimeout(t);
      t = setTimeout(load, 300);
    });
    const i = setInterval(load, 30_000);
    const w = () => backend.waConversations().then((c) => setWaPending(c.filter((x) => x.needsStaff && !x.handoffOwner).length)).catch(() => {});
    w();
    const j = setInterval(w, 30_000);
    return () => { unsub(); clearInterval(i); clearInterval(j); if (t) clearTimeout(t); };
  }, [load]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 5000); return () => clearTimeout(t); }, [flash]);

  const held = useMemo(() => rows.filter((r) => r.deskHold && r.state !== "cancelled"), [rows]);
  const recent = useMemo(() => rows.filter((r) => !r.deskHold), [rows]);
  const missed = calls.filter((c) => (c.status === "missed" && Date.now() - new Date(c.startedAt).getTime() < 6 * 3600_000) || (c.wantsCallback && !c.callbackDoneAt)).length;
  async function switchCalls(m: CallMode, voiceId?: string | null, ringSeconds?: number) {
    try {
      await backend.setCallMode(m, voiceId, ringSeconds);
      setCallModeState((c) => ({ mode: m, voiceId: voiceId ?? c.voiceId, ringSeconds: ringSeconds ?? c.ringSeconds }));
      setFlash(m === "bot" ? "Las llamadas de WhatsApp las atiende Sofía (bot de voz). Si no está disponible, suenan acá."
        : m === "smart" ? `Las llamadas suenan acá primero. Si están todos ocupados, o nadie atiende en ${ringSeconds ?? callMode.ringSeconds} s, atiende Sofía.`
        : "Las llamadas de WhatsApp suenan en la Central.");
    } catch (e) { setErr(e instanceof CommandError ? ERR[e.code] ?? e.message : (e as Error).message); }
  }

  async function switchMode(m: DeskMode) {
    try { await backend.setDeskMode(m); setMode(m); setFlash(m === "manual" ? "Modo manual: las reservas nuevas esperan acá hasta que las envíes." : "Modo automático: las reservas nuevas pasan directo a despacho."); }
    catch (e) { setErr(e instanceof CommandError ? ERR[e.code] ?? e.message : (e as Error).message); }
  }
  async function send(r: DispatchRow, method: DeskMethod) {
    setBusy(r.id); setErr(null);
    try {
      const res = await backend.deskRelease(r.id, r.version, method);
      setFlash(`${r.reference} enviada a despacho · ${METHOD[method].label}${res.note === "no_eligible_drivers" ? " (sin choferes libres: despacho alertado)" : ""}`);
    } catch (e) { setErr(e instanceof CommandError ? ERR[e.code] ?? e.message : (e as Error).message); }
    finally { setBusy(null); load(); }
  }
  const navigate = useNavigate();
  // Bell: bookings waiting here open the desk queue; the rest open in Despacho on their day.
  const openNew = useCallback((r: DispatchRow) => {
    if (r.deskHold) setTab("incoming"); else navigate(`/despacho?ref=${encodeURIComponent(r.reference)}`);
  }, [navigate]);
  const startBooking = (c?: WaCall) => {
    setNewFor({ key: crypto.randomUUID(), name: c?.name ?? undefined, phone: c?.phone, callId: c?.id });
    setTab("new");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4 px-5 py-3">
          <Logo />
          <span className="rounded-md bg-cab-500/15 px-2 py-0.5 text-xs font-semibold text-cab-300">{L.title}</span>
          <nav className="ml-2 flex gap-1 rounded-lg bg-ink-900 p-1" role="tablist">
            {([["incoming", "Entrantes", held.length], ["whatsapp", "WhatsApp", waPending], ["calls", "Llamadas", missed], ["new", "+ Nueva reserva", 0]] as const).map(([k, label, n]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => (k === "new" ? startBooking() : setTab(k))}
                className={cx("rounded-md px-3 py-1.5 text-sm font-medium", tab === k ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white")}>
                {label}{n > 0 && <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">{n}</span>}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            <StaffLangSwitch />
            <div className="flex items-center gap-2" title="Cómo llegan las reservas nuevas a despacho">
              <span className="text-xs text-ink-400">Envío a despacho</span>
              <div className="flex rounded-lg bg-ink-900 p-1" role="radiogroup" aria-label="Modo de envío" data-testid="desk-mode">
                {(["auto", "manual"] as const).map((m) => (
                  <button key={m} role="radio" aria-checked={mode === m} onClick={() => mode !== m && switchMode(m)}
                    className={cx("rounded-md px-3 py-1 text-xs font-semibold", mode === m ? (m === "auto" ? "bg-emerald-600 text-white" : "bg-cab-500 text-ink-950") : "text-ink-400 hover:text-white")}>
                    {m === "auto" ? "Auto" : "Manual"}
                  </button>
                ))}
              </div>
            </div>
            <CallModeSwitch settings={callMode} onChange={(m, ring) => switchCalls(m, null, ring)} />
            {backend.simulateCall && <Button variant="outline" className="py-1.5 text-xs" onClick={() => backend.simulateCall!()} data-testid="simulate-call">📞 Simular llamada</Button>}
            <NewBookingsBell onOpen={openNew} />
            <Link to="/despacho" className="text-ink-300 hover:text-white">Despacho →</Link>
            <span className="hidden text-ink-400 md:inline">{session.label}</span>
            <Button variant="ghost" className="px-2 py-2" onClick={onSignOut}>Salir</Button>
          </div>
        </div>
      </header>

      <div className="space-y-4 px-5 py-5">
        <CallPanel calls={calls} reload={reloadCalls} onNewBooking={startBooking}
          onOpenChat={(c) => { setChatId(c.conversationId); setTab("whatsapp"); }}
          onHistory={showHistory} />
        <TransferCalls calls={calls} reload={reloadCalls} onNewBooking={startBooking} onHistory={showHistory} />
        {flash && <div className="rounded-xl bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200" role="status">{flash}</div>}
        {err && <div className="rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-200" role="alert">{err}</div>}
        {history && <CallerHistory h={history} onClose={() => setHistory(null)} />}

        {tab === "incoming" && (
          <>
            <section data-testid="desk-queue">
              <div className="mb-2 flex items-baseline gap-3">
                <h2 className="text-lg font-semibold">Por enviar a despacho</h2>
                <span className="text-sm text-ink-400">
                  {mode === "manual" ? "Modo manual: revisá cada reserva y elegí cómo se asigna." : "Modo automático: las nuevas pasan directo; acá quedan las que llegaron en modo manual."}
                </span>
              </div>
              {held.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-ink-700 px-5 py-8 text-center text-sm text-ink-400">No hay reservas esperando.</p>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {held.map((r) => (
                    <article key={r.id} className="rounded-2xl border border-cab-500/30 bg-ink-900 p-4" data-testid={`desk-${r.reference}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-cab-400">{r.reference}</span>
                        <Badge tone={SOURCE[r.source]?.tone}>{SOURCE[r.source]?.label ?? r.source}</Badge>
                        <span className="text-xs text-ink-400">recibida {fmtTime(r.createdAt)}</span>
                        <span className="ml-auto text-sm font-semibold tabular-nums">{r.amountMinor !== null && r.currency ? formatMoney(r.amountMinor, r.currency, "es-AR") : "a cotizar"}</span>
                      </div>
                      <div className="mt-2 text-sm">
                        <div className="font-semibold text-white">{fmtDateTime(r.agreedPickupAt)} · {r.direction === "from_airport" ? `${r.airport} → ${r.dropoffPlace.label}` : `${r.pickupPlace.label} → ${r.airport}`}</div>
                        <div className="text-ink-300">{r.passengerName} · {r.passengerPhone ?? "sin teléfono"} · {r.passengers} pax · {r.largeBags} valijas{r.flightDesignator ? ` · ✈️ ${r.flightDesignator}` : ""}</div>
                        {r.notes && <div className="mt-1 text-xs text-amber-200">📝 {r.notes}</div>}
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {(["auto", "board", "manual"] as const).map((m) => (
                          <button key={m} disabled={busy === r.id} onClick={() => send(r, m)} title={METHOD[m].help}
                            className="rounded-xl border border-ink-700 px-2 py-2 text-left hover:border-cab-500 disabled:opacity-50" data-testid={`send-${m}`}>
                            <span className="block text-sm font-semibold">{METHOD[m].icon} {METHOD[m].label}</span>
                            <span className="block text-[11px] leading-tight text-ink-400">{METHOD[m].help}</span>
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-lg font-semibold">Recibidas (últimas 48 h)</h2>
              <div className="overflow-x-auto rounded-2xl border border-ink-800">
                <table className="w-full min-w-[900px] text-sm" data-testid="desk-recent">
                  <thead className="bg-ink-900 text-left text-xs uppercase tracking-wide text-ink-400">
                    <tr>{["Recibida", "Ref.", "Canal", "Pasajero", "Viaje", "Búsqueda", "Estado", "Envío"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {recent.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-ink-400">Todavía no entraron reservas.</td></tr>}
                    {recent.map((r) => (
                      <tr key={r.id} className="border-t border-ink-800">
                        <td className="px-3 py-2 tabular-nums text-ink-300">{fmtTime(r.createdAt)}</td>
                        <td className="px-3 py-2 font-mono font-semibold">{r.reference}</td>
                        <td className="px-3 py-2"><Badge tone={SOURCE[r.source]?.tone}>{SOURCE[r.source]?.label ?? r.source}</Badge></td>
                        <td className="px-3 py-2">{r.passengerName}<div className="text-xs text-ink-400">{r.passengerPhone}</div></td>
                        <td className="px-3 py-2">{r.direction === "from_airport" ? `${r.airport} → ${r.zoneName ?? ""}` : `${r.zoneName ?? ""} → ${r.airport}`}</td>
                        <td className="px-3 py-2 tabular-nums">{fmtDateTime(r.agreedPickupAt)}</td>
                        <td className="px-3 py-2"><Badge tone={r.state}>{STATE[r.state] ?? r.state}</Badge>{r.driverName && <div className="text-xs text-ink-400">{r.driverName}</div>}</td>
                        <td className="px-3 py-2 text-xs text-ink-300">{r.deskMethod ? `${METHOD[r.deskMethod].icon} ${METHOD[r.deskMethod].label}` : "Directo"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === "whatsapp" && <WhatsAppInbox key={chatId ?? "all"} initialConversationId={chatId} onCount={setWaPending} onOpenBooking={() => setTab("incoming")} />}

        {tab === "calls" && <CallsLog calls={calls} onBook={startBooking} callMode={callMode} onVoice={(v) => switchCalls(callMode.mode, v)}
          onDone={async (c) => { await backend.callbackDone(c.id).catch(() => {}); reloadCalls(); }}
          onChat={(c) => { setChatId(c.conversationId); setTab("whatsapp"); }} />}

        {tab === "new" && newFor && (
          <div className="mx-auto max-w-3xl">
            <div className="mb-4 flex flex-wrap items-baseline gap-3">
              <h2 className="text-xl font-semibold">Nueva reserva</h2>
              {newFor.callId ? <Badge tone="warn">📞 durante la llamada con {newFor.name || newFor.phone}</Badge> : <span className="text-sm text-ink-400">Cargala mientras hablás con el cliente.</span>}
            </div>
            <BookingPage key={newFor.key} staff embedded source={newFor.callId ? "phone" : "staff"}
              prefill={{ name: newFor.name, phone: newFor.phone }}
              onDone={async (b) => {
                if (newFor.callId) await backend.linkCallBooking(newFor.callId, b.reference).catch(() => {});
                setFlash(`Reserva ${b.reference} creada${mode === "manual" ? " · está en Entrantes para enviar a despacho" : " · ya está en despacho"}`);
                load();
              }} />
          </div>
        )}
      </div>
    </div>
  );
}

function CallsLog({ calls, onBook, callMode, onVoice, onDone, onChat }: {
  calls: WaCall[]; onBook: (c: WaCall) => void; callMode: CallSettings;
  onVoice: (voiceId: string) => void; onDone: (c: WaCall) => void; onChat: (c: WaCall) => void;
}) {
  const ST: Record<string, [string, string]> = {
    ringing: ["Sonando", "warn"], answering: ["Conectando", "warn"], active: ["En curso", "confirmed"], ended: ["Atendida", "neutral"],
    missed: ["Perdida", "cancelled"], rejected: ["Rechazada", "cancelled"], failed: ["Falló", "cancelled"],
  };
  const pending = calls.filter((c) => c.wantsCallback && !c.callbackDoneAt);
  const [voice, setVoice] = useState(callMode.voiceId ?? "");
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-ink-800 bg-ink-900 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">{callMode.mode === "bot" ? "🤖 Atiende Sofía, el bot de voz" : callMode.mode === "smart" ? "👤→🤖 Central primero, Sofía de respaldo" : "👤 Las llamadas suenan en la Central"}</span>
          <span className="text-ink-400">{callMode.mode === "bot"
            ? "Cotiza, reserva, informa el estado de las reservas y responde dudas. Lo que no puede resolver te lo deja abajo para devolver la llamada."
            : callMode.mode === "smart" ? `Suenan acá. Si todos están en otra llamada, o nadie atiende en ${callMode.ringSeconds} s, atiende Sofía.`
            : "Elegí 👤→🤖 o 🤖 arriba a la derecha para que Sofía atienda cuando no puedan, o siempre."}</span>
        </div>
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (voice.trim()) onVoice(voice.trim()); }}>
          <label className="text-xs text-ink-400" htmlFor="fish-voice">Voz de Fish Audio (ID)</label>
          <input id="fish-voice" value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="por defecto: voz estándar de Fish"
            className="w-80 rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-xs text-white" pattern="[A-Za-z0-9_\-]{8,64}" />
          <Button variant="outline" className="py-1 text-xs" type="submit" disabled={!voice.trim() || voice.trim() === callMode.voiceId}>Guardar voz</Button>
        </form>
      </div>

      {pending.length > 0 && (
        <section data-testid="callbacks">
          <h2 className="mb-2 text-lg font-semibold">Para devolver la llamada · {pending.length}</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {pending.map((c) => (
              <article key={c.id} className="rounded-2xl border border-red-500/30 bg-ink-900 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{c.name || c.phone}</span>
                  <a href={`https://wa.me/${c.waId}`} target="_blank" rel="noreferrer" className="text-xs text-ink-400 hover:text-white">{c.phone}</a>
                  {c.handledBy === "bot" && <Badge tone="held">🤖 Sofía</Badge>}
                  <span className="ml-auto text-xs text-ink-400">{fmtTime(c.startedAt)}</span>
                </div>
                {c.botNote && <p className="mt-2 whitespace-pre-line text-sm text-amber-100">{c.botNote}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {c.conversationId && <Button variant="outline" className="py-1 text-xs" onClick={() => onChat(c)}>Escribir por WhatsApp</Button>}
                  <Button variant="outline" className="py-1 text-xs" onClick={() => onBook(c)}>+ Reserva</Button>
                  <Button className="py-1 text-xs" onClick={() => onDone(c)}>Listo, ya lo contactamos</Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="overflow-x-auto rounded-2xl border border-ink-800">
        <table className="w-full min-w-[820px] text-sm" data-testid="calls-log">
          <thead className="bg-ink-900 text-left text-xs uppercase tracking-wide text-ink-400">
            <tr>{["Hora", "Cliente", "Atendió", "Estado", "Duración", "Reserva", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {calls.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-ink-400">Sin llamadas en las últimas 24 h.</td></tr>}
            {calls.map((c) => (
              <tr key={c.id} className="border-t border-ink-800 align-top">
                <td className="px-3 py-2 tabular-nums">{fmtTime(c.startedAt)}</td>
                <td className="px-3 py-2">{c.name || "—"}<div className="text-xs text-ink-400"><a href={`https://wa.me/${c.waId}`} target="_blank" rel="noreferrer" className="hover:text-white">{c.phone}</a></div>
                  {c.botNote && <div className="mt-1 max-w-xs text-xs text-amber-200">📝 {c.botNote}</div>}</td>
                <td className="px-3 py-2">{c.handledBy === "bot" ? "🤖 Sofía" : "👤 Central"}</td>
                <td className="px-3 py-2"><Badge tone={ST[c.status]?.[1]}>{ST[c.status]?.[0] ?? c.status}</Badge></td>
                <td className="px-3 py-2 tabular-nums">{c.durationS !== null ? `${Math.floor(c.durationS / 60)}:${String(c.durationS % 60).padStart(2, "0")}` : "—"}</td>
                <td className="px-3 py-2 font-mono">{c.bookingRef ?? "—"}</td>
                <td className="px-3 py-2 text-right">{!c.bookingRef && <Button variant="outline" className="py-1 text-xs" onClick={() => onBook(c)}>+ Reserva</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-ink-800 px-3 py-2 text-xs text-ink-400">Las reservas que toma Sofía aparecen en Entrantes con canal «Voz» y el cliente recibe el detalle por WhatsApp.</p>
      </div>
    </div>
  );
}

