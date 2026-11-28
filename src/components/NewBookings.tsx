import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, type DispatchRow } from "../lib/backend";
import { cx, fmtDateTime, fmtTime, formatMoney } from "../lib/format";

// New-booking alerts for staff screens: a bell with the unseen count, a list of the last 48 h of bookings,
// a toast + chime the moment a booking arrives from any channel (web, WhatsApp, Sofía, phone, staff),
// and an optional desktop notification when the tab is in the background.

export const SOURCE_ES: Record<string, { label: string; icon: string }> = {
  web: { label: "Web", icon: "🌐" },
  whatsapp: { label: "WhatsApp", icon: "💬" },
  voice: { label: "Sofía (llamada)", icon: "🤖" },
  phone: { label: "Teléfono", icon: "📞" },
  staff: { label: "Central", icon: "👤" },
};
const STATE_ES: Record<string, string> = {
  requested: "Solicitada", needs_driver: "Sin chofer", held: "Hold", confirmed: "Confirmada", closed: "Cerrada", cancelled: "Cancelada",
};

const SEEN_KEY = "stt.newbookings.seen";
const PREF_KEY = "stt.newbookings.prefs";
const TOAST_MS = 20_000;

function readJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage off */ } }

let audioCtx: AudioContext | null = null;
export function chime() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audioCtx ??= new AC();
    const ctx = audioCtx; if (ctx.state === "suspended") void ctx.resume();
    [880, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.5);
    });
  } catch { /* no audio */ }
}

export function routeText(r: DispatchRow) {
  return `${r.pickupPlace.label} → ${r.dropoffPlace.label}`;
}

/** Decides which rows are newly arrived. Pure, so it can be tested. */
export function diffNew(rows: DispatchRow[], seen: Set<string>, alerted: Set<string>, since: string) {
  return rows.filter((r) => !seen.has(r.id) && !alerted.has(r.id) && r.createdAt >= since && r.state !== "cancelled");
}

export function NewBookingsBell({ onOpen }: { onOpen: (r: DispatchRow) => void }) {
  const [rows, setRows] = useState<DispatchRow[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => new Set(readJson<string[]>(SEEN_KEY, [])));
  const [toasts, setToasts] = useState<DispatchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(() => readJson(PREF_KEY, { sound: true, desktop: false }));
  const alerted = useRef<Set<string>>(new Set());
  const primed = useRef(readJson<string[] | null>(SEEN_KEY, null) !== null);
  const openedAt = useRef(new Date(Date.now() - 2 * 60_000).toISOString());
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const seenRef = useRef(seen); seenRef.current = seen;

  const persistSeen = (s: Set<string>) => { setSeen(s); writeJson(SEEN_KEY, [...s].slice(-500)); };

  const load = useCallback(async () => {
    let list: DispatchRow[];
    try { list = await backend.deskRows(); } catch { return; }
    setRows(list);
    if (!primed.current) {
      // First visit on this browser: everything already there counts as seen, so we don't ring for old bookings.
      primed.current = true; persistSeen(new Set(list.map((r) => r.id))); return;
    }
    const fresh = diffNew(list, seenRef.current, alerted.current, openedAt.current);
    if (!fresh.length) return;
    fresh.forEach((r) => alerted.current.add(r.id));
    setToasts((t) => [...fresh, ...t].slice(0, 4));
    fresh.forEach((r) => setTimeout(() => setToasts((t) => t.filter((x) => x.id !== r.id)), TOAST_MS));
    if (prefsRef.current.sound) chime();
    if (prefsRef.current.desktop && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      for (const r of fresh.slice(0, 3)) {
        try {
          const n = new Notification(`Nueva reserva ${r.reference} · ${SOURCE_ES[r.source]?.label ?? r.source}`, {
            body: `${r.passengerName} · ${fmtDateTime(r.agreedPickupAt)}\n${routeText(r)}`, tag: r.id,
          });
          n.onclick = () => { window.focus(); onOpen(r); };
        } catch { /* blocked */ }
      }
    }
  }, [onOpen]);

  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = backend.subscribe((table) => {
      if (table !== "bookings") return;
      if (t) clearTimeout(t);
      t = setTimeout(load, 500);
    });
    const i = setInterval(load, 30_000);
    return () => { unsub(); clearInterval(i); if (t) clearTimeout(t); };
  }, [load]);

  const unseen = useMemo(() => rows.filter((r) => !seen.has(r.id) && r.state !== "cancelled"), [rows, seen]);

  const markSeen = (ids: string[]) => { const s = new Set(seen); ids.forEach((id) => s.add(id)); persistSeen(s); };
  const openRow = (r: DispatchRow) => { markSeen([r.id]); setToasts((t) => t.filter((x) => x.id !== r.id)); setOpen(false); onOpen(r); };
  const setPref = (p: Partial<typeof prefs>) => { const n = { ...prefs, ...p }; setPrefs(n); writeJson(PREF_KEY, n); };
  const toggleDesktop = async () => {
    if (prefs.desktop) return setPref({ desktop: false });
    if (typeof Notification === "undefined") return;
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setPref({ desktop: perm === "granted" });
  };

  return (
    <>
      <div className="relative">
        <button onClick={() => { setOpen((o) => !o); if (prefs.sound) chime(); }} aria-label={`Reservas nuevas: ${unseen.length}`} data-testid="new-bookings-bell"
          className={cx("relative rounded-lg px-2.5 py-1.5 text-lg leading-none hover:bg-ink-800", unseen.length > 0 && "animate-pulse")}>
          🔔
          {unseen.length > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">{unseen.length}</span>}
        </button>
        {open && (
          <div className="absolute right-0 z-40 mt-2 w-[26rem] rounded-2xl border border-ink-700 bg-ink-900 p-3 shadow-2xl">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold">Reservas recibidas · 48 h</span>
              {unseen.length > 0 && <button className="ml-auto text-xs text-cab-300 hover:underline" onClick={() => markSeen(unseen.map((r) => r.id))}>Marcar todo como visto</button>}
            </div>
            <div className="mb-3 flex gap-3 text-xs text-ink-300">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.sound} onChange={(e) => { setPref({ sound: e.target.checked }); if (e.target.checked) chime(); }} /> Sonido</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={prefs.desktop} onChange={toggleDesktop} /> Aviso de escritorio</label>
            </div>
            <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto">
              {rows.length === 0 && <li className="py-6 text-center text-sm text-ink-400">Sin reservas en las últimas 48 h.</li>}
              {rows.map((r) => (
                <li key={r.id}>
                  <button onClick={() => openRow(r)} className={cx("w-full rounded-xl px-3 py-2 text-left hover:bg-ink-800", !seen.has(r.id) ? "bg-cab-500/10 ring-1 ring-cab-500/40" : "bg-ink-950/40")}>
                    <Line r={r} fresh={!seen.has(r.id)} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="pointer-events-none fixed right-4 top-44 z-50 flex w-[24rem] flex-col gap-2" aria-live="polite">
        {toasts.map((r) => (
          <div key={r.id} role="alert" data-testid={`new-booking-${r.reference}`} className="pointer-events-auto rounded-2xl border border-cab-500/50 bg-ink-900 p-3 shadow-2xl">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-cab-300">🆕 Nueva reserva</div>
            <Line r={r} fresh />
            <div className="mt-2 flex gap-2">
              <button className="rounded-lg bg-cab-500 px-3 py-1.5 text-sm font-semibold text-ink-950" onClick={() => openRow(r)}>Ver reserva</button>
              <button className="rounded-lg px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800" onClick={() => setToasts((t) => t.filter((x) => x.id !== r.id))}>Cerrar</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Line({ r, fresh }: { r: DispatchRow; fresh?: boolean }) {
  const src = SOURCE_ES[r.source] ?? { label: r.source, icon: "•" };
  return (
    <div className="text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold">{r.reference}</span>
        <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-200">{src.icon} {src.label}</span>
        {r.deskHold && <span className="rounded bg-cab-500/20 px-1.5 py-0.5 text-[11px] text-cab-200">en la Central</span>}
        <span className="ml-auto text-[11px] text-ink-400">{fresh ? "recibida " : ""}{fmtTime(r.createdAt)}</span>
      </div>
      <div className="mt-0.5 text-ink-100">{r.passengerName} · {r.passengers} pax · <b>{fmtDateTime(r.agreedPickupAt)}</b>{r.flightDesignator ? ` · ✈ ${r.flightDesignator}` : ""}</div>
      <div className="truncate text-ink-400">{routeText(r)}</div>
      <div className="text-[11px] text-ink-400">{STATE_ES[r.state] ?? r.state}{r.amountMinor != null && r.currency ? ` · ${formatMoney(r.amountMinor, r.currency, "es-AR")}` : ""}</div>
    </div>
  );
}
