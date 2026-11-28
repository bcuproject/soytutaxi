// Bridge to the SoyTuTaxi Android driver app (Flutter). Inside the app the page runs in a WebView that exposes a
// JavaScript channel called "SttNative". The page hands the app the driver's session and on/off shift, and the app
// does GPS and offer alerts natively (also with the screen off) and reports back with "stt-native-location" events.

type Channel = { postMessage: (msg: string) => void };

export function nativeChannel(): Channel | null {
  const ch = (window as unknown as { SttNative?: Channel }).SttNative;
  return ch && typeof ch.postMessage === "function" ? ch : null;
}

export const inNativeApp = () => nativeChannel() !== null;

export function postNative(msg: Record<string, unknown>) {
  try { nativeChannel()?.postMessage(JSON.stringify(msg)); } catch { /* app closed the channel */ }
}

export interface NativeLocationStatus { sentAt?: string | null; accuracy?: number | null; error?: string | null }

/** Location status pushed by the app (window.dispatchEvent(new CustomEvent("stt-native-location", { detail }))). */
export function onNativeLocation(cb: (s: NativeLocationStatus) => void): () => void {
  const h = (e: Event) => cb(((e as CustomEvent).detail ?? {}) as NativeLocationStatus);
  window.addEventListener("stt-native-location", h);
  return () => window.removeEventListener("stt-native-location", h);
}
