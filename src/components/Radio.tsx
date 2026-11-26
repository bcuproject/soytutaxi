// Walkie-talkie: one shared LiveKit room. Hold the button to talk; release to listen.
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from "livekit-client";
import { backend, CommandError } from "../lib/backend";
import { cx } from "../lib/format";

type Status = "off" | "connecting" | "on" | "error";

export function Radio({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const [status, setStatus] = useState<Status>("off");
  const [error, setError] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const room = useRef<Room | null>(null);
  const audioBox = useRef<HTMLDivElement>(null);

  const disconnect = useCallback(async () => {
    await room.current?.disconnect();
    room.current = null;
    setStatus("off"); setTalking(false); setSpeakers([]);
  }, []);

  useEffect(() => () => { room.current?.disconnect(); }, []);
  useEffect(() => { if (disabled && status !== "off") disconnect(); }, [disabled, status, disconnect]);

  async function connect() {
    setStatus("connecting"); setError(null);
    try {
      const t = await backend.radioToken();
      const r = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) audioBox.current?.appendChild(track.attach());
      });
      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()));
      r.on(RoomEvent.ActiveSpeakersChanged, (ps: Participant[]) => setSpeakers(ps.filter((p) => !p.isLocal).map((p) => p.name || p.identity)));
      const recount = () => setCount(r.remoteParticipants.size);
      r.on(RoomEvent.ParticipantConnected, recount).on(RoomEvent.ParticipantDisconnected, recount);
      r.on(RoomEvent.Disconnected, () => { setStatus("off"); setTalking(false); });
      await r.connect(t.url, t.token);
      await r.startAudio();                                   // unlock playback (we are inside a click)
      await r.localParticipant.setMicrophoneEnabled(true);
      await r.localParticipant.setMicrophoneEnabled(false);   // mic permission granted, muted until held
      room.current = r;
      recount();
      setStatus("on");
    } catch (e) {
      const code = e instanceof CommandError ? e.code : "";
      setError(code === "radio_not_configured" ? "Radio sin configurar (faltan las claves de LiveKit)."
        : code === "off_shift" ? "Iniciá el turno para usar la radio."
        : code === "live_only" ? "La radio funciona solo en modo en vivo."
        : (e as Error).name === "NotAllowedError" ? "Permití el micrófono para hablar."
        : "No se pudo conectar la radio.");
      setStatus("error");
      await room.current?.disconnect();
      room.current = null;
    }
  }

  async function talk(on: boolean) {
    if (!room.current || status !== "on") return;
    setTalking(on);
    try { await room.current.localParticipant.setMicrophoneEnabled(on); } catch { setTalking(false); }
  }

  const pttProps = {
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); talk(true); },
    onPointerUp: () => talk(false),
    onPointerCancel: () => talk(false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); talk(true); } },
    onKeyUp: (e: React.KeyboardEvent) => { if (e.key === " " || e.key === "Enter") talk(false); },
  };

  return (
    <div className={cx("flex items-center gap-2", !compact && "flex-col items-stretch")} data-testid="radio">
      <div ref={audioBox} hidden />
      {status !== "on" ? (
        <button type="button" disabled={disabled || status === "connecting"} onClick={connect}
          className={cx("rounded-xl border border-ink-600 px-3 py-2 text-sm font-semibold text-white hover:border-cab-500 disabled:opacity-40", !compact && "py-3")}>
          📻 {status === "connecting" ? "Conectando…" : "Encender radio"}
        </button>
      ) : (
        <>
          <button type="button" aria-pressed={talking} {...pttProps}
            className={cx("select-none touch-none rounded-xl font-bold transition",
              compact ? "px-4 py-2 text-sm" : "py-6 text-lg",
              talking ? "bg-red-500 text-white ring-4 ring-red-500/30" : "bg-cab-500 text-ink-950 hover:bg-cab-400")}>
            {talking ? "● Hablando…" : "Mantener para hablar"}
          </button>
          <div className={cx("text-xs", compact ? "max-w-[10rem]" : "text-center")}>
            {speakers.length ? <span className="font-semibold text-emerald-300">🔊 {speakers.join(", ")}</span>
              : <span className="text-ink-400">{count} en la radio</span>}
          </div>
          <button type="button" onClick={disconnect} className="text-xs text-ink-400 hover:text-white">Apagar</button>
        </>
      )}
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </div>
  );
}
