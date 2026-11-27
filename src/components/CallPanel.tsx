// WhatsApp voice calls in the browser (Cloud API Calling over WebRTC): ringing, answer, mute, hang up.
// Meta sends an SDP offer with the call; the browser answers it and the `whatsapp` function relays the
// answer to Meta (pre_accept + accept). Audio flows directly between this browser and WhatsApp.
import { useCallback, useEffect, useRef, useState } from "react";
import { backend, CommandError, type WaCall } from "../lib/backend";
import { cx } from "../lib/format";
import { Button } from "./ui";

const ERR: Record<string, string> = {
  call_taken: "Otra persona ya atendió esta llamada.",
  call_missed: "La llamada se cortó antes de atender.",
  call_ended: "La llamada ya terminó.",
  whatsapp_not_configured: "WhatsApp todavía no está conectado.",
  accept_failed: "WhatsApp rechazó la conexión. Probá de nuevo.",
  NotAllowedError: "El navegador no tiene permiso para usar el micrófono.",
};

/** One live call at a time per browser. */
interface Session { callId: string; pc: RTCPeerConnection | null; mic: MediaStream | null; audio: HTMLAudioElement }
let session: Session | null = null;

function cleanup() {
  if (!session) return;
  session.pc?.close();
  session.mic?.getTracks().forEach((t) => t.stop());
  session.audio.srcObject = null;
  session = null;
}

async function iceComplete(pc: RTCPeerConnection, ms: number) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
  });
}

async function answer(call: WaCall) {
  const audio = new Audio();
  audio.autoplay = true;
  if (!call.offerSdp) {                       // demo mode: no media
    session = { callId: call.id, pc: null, mic: null, audio };
    await backend.callAction(call.id, "accept");
    return;
  }
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  session = { callId: call.id, pc, mic, audio };
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  pc.ontrack = (e) => { audio.srcObject = e.streams[0] ?? new MediaStream([e.track]); audio.play().catch(() => {}); };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: call.offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await iceComplete(pc, 2500);
    await backend.callAction(call.id, "accept", pc.localDescription!.sdp);
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Simple ring tone (two short beeps every 2 s) with Web Audio. */
export function useRing(on: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!on) return;
    const beep = () => {
      try {
        ctx.current ??= new AudioContext();
        const c = ctx.current;
        for (const at of [0, 0.25]) {
          const o = c.createOscillator(), g = c.createGain();
          o.frequency.value = 880; g.gain.value = 0.08;
          o.connect(g).connect(c.destination);
          o.start(c.currentTime + at); o.stop(c.currentTime + at + 0.15);
        }
      } catch { /* audio blocked until the user clicks */ }
    };
    beep();
    const i = setInterval(beep, 2000);
    return () => clearInterval(i);
  }, [on]);
}

function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(i); }, [on]);
}
const mmss = (from: string | null) => {
  if (!from) return "0:00";
  const s = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function useCalls() {
  const [calls, setCalls] = useState<WaCall[]>([]);
  const load = useCallback(() => backend.waCalls().then(setCalls).catch(() => {}), []);
  useEffect(() => {
    load();
    const unsub = backend.subscribe((t) => { if (t === "wa_calls") load(); });
    const i = setInterval(load, 10_000);
    return () => { unsub(); clearInterval(i); };
  }, [load]);
  // The other side hung up → release the microphone.
  useEffect(() => {
    if (session && calls.some((c) => c.id === session!.callId && ["ended", "missed", "rejected", "failed"].includes(c.status))) cleanup();
  }, [calls]);
  return { calls, reload: load };
}

export function CallPanel({ calls, reload, onNewBooking, onOpenChat, onHistory }: {
  calls: WaCall[]; reload: () => void;
  onNewBooking: (c: WaCall) => void; onOpenChat: (c: WaCall) => void; onHistory: (c: WaCall) => void;
}) {
  const ringing = calls.filter((c) => c.status === "ringing" && Date.now() - new Date(c.startedAt).getTime() < 90_000);
  const mine = calls.find((c) => (c.status === "active" || c.status === "answering") && c.answeredByMe);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  useRing(ringing.length > 0 && !mine);
  useTicker(ringing.length > 0 || !!mine);

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id); setErr(null);
    try { await fn(); } catch (e) {
      const code = e instanceof CommandError ? e.code : (e as Error).name;
      setErr(ERR[code] ?? (e as Error).message);
    } finally { setBusy(null); reload(); }
  }
  const toggleMute = () => {
    const m = !muted;
    session?.mic?.getAudioTracks().forEach((t) => (t.enabled = !m));
    setMuted(m);
  };

  if (!ringing.length && !mine && !err) return null;
  return (
    <div className="space-y-2" data-testid="call-panel">
      {mine && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400" /></span>
          <div>
            <div className="font-semibold text-white">En llamada · {mine.name || mine.phone}</div>
            <div className="text-xs text-emerald-200/80">{mine.phone} · <span className="tabular-nums">{mmss(mine.connectedAt)}</span>{mine.bookingRef && <> · reserva {mine.bookingRef}</>}</div>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" className="py-1.5 text-sm" onClick={() => onHistory(mine)}>Historial</Button>
            <Button variant="outline" className="py-1.5 text-sm" onClick={() => onOpenChat(mine)}>Chat</Button>
            <Button className="py-1.5 text-sm" onClick={() => onNewBooking(mine)}>+ Reserva para este cliente</Button>
            <Button variant="outline" className="py-1.5 text-sm" onClick={toggleMute}>{muted ? "🎙️ Activar mic" : "🔇 Silenciar"}</Button>
            <button disabled={busy === mine.id} onClick={() => run(mine.id, async () => { await backend.callAction(mine.id, "terminate"); cleanup(); })}
              className="rounded-xl bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50">Colgar</button>
          </div>
        </div>
      )}
      {!mine && ringing.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-cab-500/50 bg-cab-500/10 px-4 py-3" data-testid="call-ringing">
          <span className="animate-bounce text-2xl" aria-hidden>📞</span>
          <div>
            <div className="font-semibold text-white">Llamada entrante · {c.name || c.phone}</div>
            <div className="text-xs text-ink-300">{c.phone} · WhatsApp · sonando <span className="tabular-nums">{mmss(c.startedAt)}</span></div>
          </div>
          <div className="ml-auto flex gap-2">
            <button disabled={!!busy} onClick={() => run(c.id, () => answer(c))}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy === c.id ? "Conectando…" : "Atender"}</button>
            <button disabled={!!busy} onClick={() => run(c.id, () => backend.callAction(c.id, "reject"))}
              className={cx("rounded-xl border border-red-500/50 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10 disabled:opacity-50")}>Rechazar</button>
          </div>
        </div>
      ))}
      {err && <div role="alert" className="rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-200">{err} <button className="ml-2 underline" onClick={() => setErr(null)}>ok</button></div>}
    </div>
  );
}
