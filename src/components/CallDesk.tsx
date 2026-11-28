import { useCallback, useEffect, useRef, useState } from "react";
import { backend, CommandError, type CallMode, type CallSettings, type WaCall } from "../lib/backend";
import { cx } from "../lib/format";
import BookingPage from "../pages/BookingPage";
import { CallerHistory, type CallerHistoryData } from "./CallerHistory";
import { CallPanel, useCalls } from "./CallPanel";
import { Badge, Button } from "./ui";

// Calls for any staff screen: who answers (switch), ringing calls, and — the moment you answer — a booking
// form already filled with the caller, next to their history. Used by Despacho; the Central has its own layout.

const MODES: { mode: CallMode; label: string; help: string }[] = [
  { mode: "desk", label: "👤 Central", help: "Las llamadas suenan acá. Si nadie atiende, quedan como perdidas." },
  { mode: "smart", label: "👤→🤖 Central + Sofía", help: "Suenan acá primero. Si todos están en otra llamada, o nadie atiende a tiempo, atiende Sofía." },
  { mode: "bot", label: "🤖 Sofía", help: "Sofía atiende todas las llamadas. Si necesita una persona, te pasa la llamada." },
];

export function useCallSettings() {
  const [s, setS] = useState<CallSettings>({ mode: "desk", voiceId: null, ringSeconds: 20 });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { backend.callMode().then(setS).catch(() => {}); }, []);
  const change = useCallback(async (mode: CallMode, ringSeconds?: number) => {
    setErr(null);
    try {
      await backend.setCallMode(mode, null, ringSeconds);
      setS((c) => ({ ...c, mode, ringSeconds: ringSeconds ?? c.ringSeconds }));
    } catch (e) { setErr(e instanceof CommandError ? e.message || e.code : (e as Error).message); }
  }, []);
  return { settings: s, change, err };
}

/** Three-way switch: Central / Central + Sofía / Sofía, with the ring time for the middle one. */
export function CallModeSwitch({ settings, onChange, compact }: { settings: CallSettings; onChange: (m: CallMode, ring?: number) => void; compact?: boolean }) {
  const cur = MODES.find((m) => m.mode === settings.mode) ?? MODES[0];
  return (
    <div className="flex items-center gap-2" title={cur.help}>
      {!compact && <span className="text-xs text-ink-400">Llamadas</span>}
      <div className="flex rounded-lg bg-ink-900 p-1" role="radiogroup" aria-label="Quién atiende las llamadas" data-testid="call-mode">
        {MODES.map((m) => (
          <button key={m.mode} role="radio" aria-checked={settings.mode === m.mode} title={m.help} data-mode={m.mode}
            onClick={() => settings.mode !== m.mode && onChange(m.mode)}
            className={cx("whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold",
              settings.mode === m.mode ? (m.mode === "bot" ? "bg-sky-600 text-white" : m.mode === "smart" ? "bg-violet-600 text-white" : "bg-emerald-600 text-white") : "text-ink-400 hover:text-white")}>
            {m.label}
          </button>
        ))}
      </div>
      {settings.mode === "smart" && (
        <select value={settings.ringSeconds} onChange={(e) => onChange("smart", Number(e.target.value))} aria-label="Segundos antes de que atienda Sofía"
          className="rounded-md border border-ink-700 bg-ink-900 px-1.5 py-1 text-xs text-ink-200" data-testid="ring-seconds">
          {[10, 15, 20, 30, 45].map((n) => <option key={n} value={n}>Sofía a los {n} s</option>)}
        </select>
      )}
    </div>
  );
}

/** Ringing calls + the "call in progress" sheet (booking form and caller history) for Despacho. */
export function CallDesk({ onOpenChat }: { onOpenChat?: (c: WaCall) => void }) {
  const { calls, reload } = useCalls();
  const mine = calls.find((c) => (c.status === "active" || c.status === "answering") && c.answeredByMe) ?? null;
  const [sheet, setSheet] = useState<{ call: WaCall; key: string; focus: "both" | "history" } | null>(null);
  const opened = useRef<Set<string>>(new Set());

  // Answering a call opens the sheet once by itself; it can be closed and reopened from the call bar.
  useEffect(() => {
    if (mine && !opened.current.has(mine.id)) {
      opened.current.add(mine.id);
      setSheet({ call: mine, key: crypto.randomUUID(), focus: "both" });
    }
  }, [mine?.id]);

  return (
    <>
      <CallPanel calls={calls} reload={reload}
        onNewBooking={(c) => setSheet({ call: c, key: crypto.randomUUID(), focus: "both" })}
        onHistory={(c) => setSheet({ call: c, key: crypto.randomUUID(), focus: "history" })}
        onOpenChat={(c) => onOpenChat?.(c)} />
      {sheet && <CallSheet key={sheet.key} call={sheet.call} live={mine?.id === sheet.call.id} withBooking={sheet.focus === "both"} onClose={() => setSheet(null)} />}
    </>
  );
}

function CallSheet({ call, live, withBooking, onClose }: { call: WaCall; live: boolean; withBooking: boolean; onClose: () => void }) {
  const [hist, setHist] = useState<CallerHistoryData | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([backend.callerHistory(call.phone), backend.callerCalls(call.phone).catch(() => [])])
      .then(([rows, calls]) => setHist({ call, rows, calls })).catch(() => setHist({ call, rows: [], calls: [] }));
  }, [call.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" role="dialog" aria-label="Llamada en curso" data-testid="call-sheet">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden border-l border-ink-700 bg-ink-950 shadow-2xl">
        <div className={cx("flex flex-wrap items-center gap-3 border-b border-ink-800 px-5 py-3", backend.mode === "demo" && "pt-8")}>
          <span className="text-xl" aria-hidden>📞</span>
          <div>
            <div className="font-semibold">{call.name || call.phone}</div>
            <div className="text-xs text-ink-400">{call.phone}</div>
          </div>
          {live ? <Badge tone="confirmed">En llamada</Badge> : <Badge tone="neutral">Llamada terminada</Badge>}
          {done && <Badge tone="confirmed">Reserva {done} creada</Badge>}
          <button onClick={onClose} className="ml-auto rounded-lg px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-white">Cerrar ✕</button>
        </div>
        <div className={cx("grid min-h-0 flex-1 gap-5 overflow-y-auto p-5", withBooking && "xl:grid-cols-[22rem_1fr]")}>
          <aside className="space-y-3" data-testid="call-sheet-history">
            {hist ? <CallerHistory h={hist} /> : <p className="text-sm text-ink-400">Cargando historial…</p>}
          </aside>
          {withBooking && (
            <section data-testid="call-sheet-booking">
              <h2 className="mb-3 text-lg font-semibold">Nueva reserva</h2>
              <BookingPage staff embedded source="phone" prefill={{ name: call.name ?? undefined, phone: call.phone }}
                onDone={async (b) => { await backend.linkCallBooking(call.id, b.reference).catch(() => {}); setDone(b.reference); }} />
            </section>
          )}
        </div>
        {withBooking && !done && <div className="border-t border-ink-800 px-5 py-2 text-xs text-ink-400">Cargá los datos mientras hablás. Al confirmar, la reserva aparece en el despacho y el cliente recibe el detalle por WhatsApp.</div>}
        {done && <div className="border-t border-ink-800 px-5 py-2"><Button className="py-1.5 text-sm" onClick={onClose}>Listo</Button></div>}
      </div>
    </div>
  );
}
