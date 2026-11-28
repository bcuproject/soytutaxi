// Calls Sofía is passing to a person. "Atender" joins the call's LiveKit room from the browser; Sofía steps out
// as soon as the agent is in. If nobody answers within ~45 s, Sofía takes the call back and leaves a callback note.
import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { backend, CommandError, type WaCall } from "../lib/backend";
import { useRing } from "./CallPanel";
import { Button } from "./ui";

const ERR: Record<string, string> = {
  transfer_taken: "Otra persona ya tomó esta llamada (o el cliente cortó).", voice_not_configured: "Falta configurar LiveKit en el servidor.",
  live_only: "En el modo demo no hay audio real: en vivo acá hablarías con el cliente.", forbidden: "Tu usuario no puede atender llamadas.",
};

export function TransferCalls({ calls, reload, onNewBooking, onHistory }: { calls: WaCall[]; reload: () => void; onNewBooking: (c: WaCall) => void; onHistory?: (c: WaCall) => void }) {
  const waiting = calls.filter((c) => c.handledBy === "bot" && c.transferRequestedAt && !c.transferTakenAt && !c.transferFailedAt
    && !["ended", "missed", "rejected", "failed"].includes(c.status) && Date.now() - new Date(c.transferRequestedAt).getTime() < 60_000);
  const [live, setLive] = useState<{ call: WaCall; room: Room } | null>(null);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const audio = useRef<HTMLDivElement>(null);
  useRing(waiting.length > 0 && !live);
  useEffect(() => () => { live?.room.disconnect(); }, [live]);

  async function take(c: WaCall) {
    setErr(null);
    try {
      const { url, token } = await backend.joinTransfer(c.id);
      const room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      room.on(RoomEvent.TrackSubscribed, (t: RemoteTrack) => { if (t.kind === Track.Kind.Audio) audio.current?.appendChild(t.attach()); });
      room.on(RoomEvent.ParticipantDisconnected, () => { if (room.remoteParticipants.size === 0) hang(room); });
      room.on(RoomEvent.Disconnected, () => { setLive(null); reload(); });
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setLive({ call: c, room });
    } catch (e) {
      const code = e instanceof CommandError ? e.code : "";
      setErr(ERR[code] ?? (e as Error).message);
      reload();
    }
  }
  function hang(room: Room) { room.disconnect(); setLive(null); reload(); }

  if (!waiting.length && !live && !err) return null;
  return (
    <div className="space-y-2" data-testid="transfer-calls">
      <div ref={audio} hidden />
      {live && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <div><div className="font-semibold text-white">En llamada (transferida por Sofía) · {live.call.name || live.call.phone}</div>
            <div className="text-xs text-emerald-200/80">{live.call.phone}{live.call.transferReason && ` · ${live.call.transferReason}`}</div></div>
          <div className="ml-auto flex gap-2">
            {onHistory && <Button variant="outline" className="py-1.5 text-sm" onClick={() => onHistory(live.call)}>📋 Historial</Button>}
            <Button className="py-1.5 text-sm" onClick={() => onNewBooking(live.call)}>+ Reserva para este cliente</Button>
            <Button variant="outline" className="py-1.5 text-sm" onClick={async () => { await live.room.localParticipant.setMicrophoneEnabled(muted); setMuted(!muted); }}>{muted ? "🎙️ Activar mic" : "🔇 Silenciar"}</Button>
            <button onClick={() => hang(live.room)} className="rounded-xl bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-500">Colgar</button>
          </div>
        </div>
      )}
      {!live && waiting.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-cab-500/50 bg-cab-500/10 px-4 py-3" data-testid="transfer-card">
          <span className="text-2xl" aria-hidden>🤖→👤</span>
          <div><div className="font-semibold text-white">Sofía te pasa una llamada · {c.name || c.phone}</div>
            <div className="text-xs text-cab-200/80">{c.transferReason ?? "Pidió hablar con una persona"} · el cliente espera en línea</div></div>
          {onHistory && <Button variant="ghost" className="ml-auto py-1.5" onClick={() => onHistory(c)}>📋 Historial</Button>}
          <Button className={onHistory ? "py-1.5" : "ml-auto py-1.5"} onClick={() => take(c)}>Atender</Button>
        </div>
      ))}
      {err && <p className="rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-200" role="alert">{err}</p>}
    </div>
  );
}
