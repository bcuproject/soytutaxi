// Dispatch WhatsApp inbox: every chat with the booking bot, staff takeover and manual replies.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { backend, CommandError, type WaConversation, type WaMessage } from "../lib/backend";
import { cx, fmtTime } from "../lib/format";
import { Badge, Button } from "./ui";

const STEP_ES: Record<string, string> = {
  menu: "menú", direction: "eligiendo sentido", airport: "eligiendo aeropuerto", zone: "eligiendo zona", address: "dirección",
  date: "fecha", date_pick: "fecha", time: "hora", flight: "vuelo", passengers: "pasajeros", bags: "valijas", carry: "equipaje de mano",
  review: "revisando precio", change: "cambiando datos", vehicle: "vehículo", name: "nombre", payment: "pago", done: "reserva hecha", handoff: "espera a una persona",
};
const ERR_ES: Record<string, string> = {
  window_closed: "Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp sólo permite plantillas aprobadas.",
  whatsapp_not_configured: "WhatsApp todavía no está conectado (faltan los secretos de Meta).",
  forbidden: "Tu usuario no tiene permiso de despacho.",
};

function ago(iso: string | null) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return fmtTime(iso);
  return new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" }).format(new Date(iso));
}

/** WhatsApp *bold* / _italic_ → React, safely (no HTML injection). */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return <>{parts.map((p, i) => p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <strong key={i}>{p.slice(1, -1)}</strong>
    : p.startsWith("_") && p.endsWith("_") && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : <span key={i}>{p}</span>)}</>;
}

const TICK: Record<string, string> = { queued: "🕓", sent: "✓", delivered: "✓✓", read: "✓✓", failed: "⚠️" };

export function WhatsAppInbox({ onOpenBooking, onCount, initialConversationId }: { onOpenBooking: (ref: string) => void; onCount?: (n: number) => void; initialConversationId?: string | null }) {
  const [convs, setConvs] = useState<WaConversation[]>([]);
  const [sel, setSel] = useState<string | null>(initialConversationId ?? null);
  const [msgs, setMsgs] = useState<WaMessage[]>([]);
  const [filter, setFilter] = useState<"all" | "staff" | "passenger" | "driver">("all");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(() => backend.waConversations().then((c) => { setConvs(c); onCount?.(c.filter((x) => x.needsStaff && !x.handoffOwner).length); }).catch((e) => setErr((e as Error).message)), [onCount]);
  const loadMsgs = useCallback((id: string) => backend.waMessages(id).then(setMsgs).catch(() => {}), []);

  useEffect(() => { loadConvs(); }, [loadConvs]);
  useEffect(() => { if (sel) loadMsgs(sel); else setMsgs([]); }, [sel, loadMsgs]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = backend.subscribe((table) => {
      if (table !== "wa_conversations" && table !== "wa_messages") return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { loadConvs(); if (sel) loadMsgs(sel); }, 250);
    });
    const poll = setInterval(() => { loadConvs(); if (sel) loadMsgs(sel); }, 20_000);
    return () => { unsub(); clearInterval(poll); if (t) clearTimeout(t); };
  }, [loadConvs, loadMsgs, sel]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const shown = useMemo(() => convs.filter((c) => filter === "all" || (filter === "staff" ? c.needsStaff || !!c.handoffOwner : c.kind === filter)), [convs, filter]);
  const cur = convs.find((c) => c.id === sel) ?? null;

  async function act(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); await loadConvs(); if (sel) await loadMsgs(sel); }
    catch (e) { setErr(e instanceof CommandError ? ERR_ES[e.code] ?? e.message : (e as Error).message); }
    finally { setBusy(false); }
  }
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || !cur) return;
    act(async () => { await backend.waSend(cur.id, t); setText(""); });
  };

  return (
    <div className="grid h-[calc(100vh-150px)] min-h-[480px] grid-cols-1 overflow-hidden rounded-xl border border-ink-800 md:grid-cols-[340px_1fr]" data-testid="wa-inbox">
      <aside className={cx("flex min-h-0 flex-col border-r border-ink-800 bg-ink-900/60", sel && "hidden md:flex")}>
        <div className="flex gap-1 border-b border-ink-800 p-2 text-xs">
          {([["all", "Todas"], ["staff", "Para el equipo"], ["passenger", "Pasajeros"], ["driver", "Choferes"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={cx("rounded-md px-2 py-1 font-medium", filter === k ? "bg-ink-700 text-white" : "text-ink-400 hover:text-white")}>{l}</button>
          ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 && <li className="p-6 text-center text-sm text-ink-400">Sin conversaciones todavía. Cuando un cliente escriba al número de WhatsApp aparece acá.</li>}
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => setSel(c.id)} className={cx("w-full border-b border-ink-800/70 px-3 py-2.5 text-left hover:bg-ink-800/60", sel === c.id && "bg-ink-800")}>
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-white">{c.name || c.phone}</span>
                  {c.kind === "driver" && <Badge tone="held">chofer</Badge>}
                  <span className="ml-auto shrink-0 text-[11px] text-ink-400">{ago(c.lastAt)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-xs text-ink-400">{c.lastDirection === "out" ? "↩ " : ""}{(c.lastPreview ?? "").replace(/\*/g, "").split("\n")[0]}</span>
                  {c.needsStaff && !c.handoffOwner && <span className="ml-auto shrink-0"><Badge tone="cancelled">pide persona</Badge></span>}
                  {c.handoffOwner && <span className="ml-auto shrink-0"><Badge tone="confirmed">{c.handledByMe ? "atendés vos" : "atendida"}</Badge></span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className={cx("flex min-h-0 flex-col bg-ink-950", !sel && "hidden md:flex")}>
        {!cur ? (
          <div className="m-auto max-w-sm p-8 text-center text-sm text-ink-400">
            Elegí una conversación. El asistente reserva solo; si el cliente pide una persona o el viaje se cotiza a mano, la conversación se marca <b className="text-red-300">pide persona</b>.
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 px-4 py-2.5">
              <button className="mr-1 text-ink-400 md:hidden" onClick={() => setSel(null)} aria-label="Volver">←</button>
              <div className="min-w-0">
                <div className="truncate font-semibold text-white">{cur.name || cur.phone}</div>
                <div className="text-xs text-ink-400">
                  <a className="hover:text-white" href={`https://wa.me/${cur.waId}`} target="_blank" rel="noreferrer">{cur.phone}</a>
                  {" · "}{cur.locale === "en" ? "inglés" : "español"}{" · "}{cur.handoffOwner ? "bot en pausa" : `bot: ${STEP_ES[cur.step] ?? cur.step}`}
                </div>
              </div>
              {cur.lastBookingRef && <button onClick={() => onOpenBooking(cur.lastBookingRef!)} className="rounded-md bg-ink-800 px-2 py-1 text-xs font-semibold text-sky-300 hover:bg-ink-700">{cur.lastBookingRef}</button>}
              <div className="ml-auto flex gap-2">
                {!cur.handoffOwner
                  ? <Button className="py-1.5 text-sm" disabled={busy} onClick={() => act(() => backend.waTakeover(cur.id, true))}>Tomar conversación</Button>
                  : <Button variant="outline" className="py-1.5 text-sm" disabled={busy} onClick={() => act(() => backend.waTakeover(cur.id, false))}>Devolver al bot</Button>}
              </div>
            </header>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4" data-testid="wa-thread">
              {msgs.map((m) => (
                <div key={m.id} className={cx("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
                  <div className={cx("max-w-[78%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-snug",
                    m.direction === "in" ? "rounded-bl-sm bg-ink-800 text-ink-100" : m.staff ? "rounded-br-sm bg-sky-700/70 text-white" : "rounded-br-sm bg-emerald-800/70 text-white")}>
                    <Rich text={m.preview} />
                    <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] opacity-70">
                      {m.direction === "out" && <span>{m.staff ? "equipo" : "bot"}</span>}
                      <span>{fmtTime(m.at)}</span>
                      {m.direction === "out" && <span className={cx(m.status === "read" && "text-sky-300", m.status === "failed" && "text-red-300")} title={m.error ?? m.status}>{TICK[m.status] ?? ""}</span>}
                    </div>
                    {m.status === "failed" && m.error && <div className="mt-1 text-[11px] text-red-200">No se entregó: {m.error}</div>}
                  </div>
                </div>
              ))}
              <div ref={bottom} />
            </div>

            {err && <div className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">{err}</div>}
            <form onSubmit={send} className="flex items-end gap-2 border-t border-ink-800 p-3">
              {cur.handledByMe ? (
                <>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e as unknown as FormEvent); } }}
                    placeholder={cur.windowOpen ? "Escribí la respuesta… (Enter envía, Shift+Enter nueva línea)" : "Ventana de 24 h cerrada: el cliente tiene que escribir primero."}
                    disabled={!cur.windowOpen || busy}
                    className="min-h-[44px] flex-1 resize-none rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-white placeholder:text-ink-500 focus:border-sky-500 focus:outline-none" />
                  <Button type="submit" disabled={!text.trim() || !cur.windowOpen || busy} className="py-2.5">Enviar</Button>
                </>
              ) : (
                <p className="flex-1 text-sm text-ink-400">
                  {cur.handoffOwner ? "Otra persona del equipo está atendiendo este chat." : "El bot está respondiendo. Tomá la conversación para escribir vos (el bot se pausa)."}
                </p>
              )}
            </form>
          </>
        )}
      </section>
    </div>
  );
}
