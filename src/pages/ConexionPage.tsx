// /conexion — set up the integrations without the Supabase dashboard:
//  1) create the first admin with a one-time setup code (or sign in),
//  2) enter the integration keys: saved write-only into Supabase Vault, never shown again,
//  3) connect the WhatsApp number (WhatsAppSetup).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { backend, CommandError, type SecretStatus, type StaffSession } from "../lib/backend";
import { cx } from "../lib/format";
import { Button, Input } from "../components/ui";
import { WhatsAppSetup } from "../components/WhatsAppSetup";
import { StaffLogin } from "./DispatchPage";

const ERR: Record<string, string> = {
  invalid_code: "El código de configuración no es válido o ya se usó.", weak_password: "La contraseña necesita al menos 10 caracteres.",
  invalid_email: "Revisá el e-mail.", forbidden: "Tu usuario no es administrador.", live_only: "Disponible solo en modo en vivo.",
  value_too_long: "Uno de los valores es demasiado largo.",
};
const errText = (e: unknown) => ERR[(e as CommandError).code ?? ""] ?? (e as Error).message;

const GROUPS: { title: string; hint: string; keys: string[] }[] = [
  { title: "WhatsApp (Meta)", hint: "Token de System User con permisos whatsapp_business_management y whatsapp_business_messaging. El App secret es el de la app de Meta a la que pertenece el token.",
    keys: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] },
  { title: "Sofía y transferencias (LiveKit)", hint: "Los mismos datos de LiveKit Cloud que usa el servidor de voz.", keys: ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] },
  { title: "Asistente con IA", hint: "Para que el bot de WhatsApp responda preguntas libres.", keys: ["AI_API_KEY"] },
  { title: "Vuelos (opcional)", hint: "AeroDataBox por API.Market o RapidAPI.", keys: ["FLIGHTS_API_KEY", "FLIGHTS_PROVIDER"] },
  { title: "Mercado Pago (opcional)", hint: "Empezá con las credenciales de prueba (TEST-…).", keys: ["MP_ACCESS_TOKEN", "MP_WEBHOOK_SECRET", "MP_COLLECTOR_ID"] },
];
const randomWord = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32);

export default function ConexionPage() {
  const [session, setSession] = useState<StaffSession | null | undefined>(undefined);
  useEffect(() => { backend.staffSession().then(setSession); }, []);
  if (session === undefined) return null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8" data-testid="conexion">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Conexiones de SoyTuTaxi</h1>
        <Link to="/despacho" className="text-sm text-ink-400 hover:text-white">Despacho →</Link>
      </div>
      {!session ? <Access onDone={setSession} /> : (
        <>
          <p className="mb-4 text-sm text-ink-400">Sesión: {session.email} · <button className="underline" onClick={async () => { await backend.signOut(); setSession(null); }}>salir</button></p>
          <Keys />
          <div className="mt-6"><WhatsAppSetup /></div>
        </>
      )}
    </div>
  );
}

function Access({ onDone }: { onDone: (s: StaffSession) => void }) {
  const [mode, setMode] = useState<"create" | "login">("create");
  const [f, setF] = useState({ code: "", email: "", password: "", confirm: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (mode === "login") return (<div><StaffLogin onDone={onDone} title="Conexiones" /><button className="mt-3 text-sm text-ink-400 underline" onClick={() => setMode("create")}>Crear el primer administrador</button></div>);
  return (
    <form className="rounded-2xl border border-ink-700 bg-ink-900 p-5" data-testid="bootstrap" onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      if (f.password !== f.confirm) { setErr("Las contraseñas no coinciden."); return; }
      setBusy(true);
      try { await backend.bootstrapAdmin(f.code, f.email, f.password); onDone(await backend.signIn(f.email, f.password)); }
      catch (x) { setErr(errText(x)); } finally { setBusy(false); }
    }}>
      <h2 className="font-semibold text-white">Crear el administrador</h2>
      <p className="mt-1 text-sm text-ink-400">Usá el código de configuración de un solo uso que te dieron. Elegí tu e-mail y tu contraseña: nadie más los ve.</p>
      <div className="mt-4 grid gap-3">
        <label className="text-xs text-ink-400">Código de configuración<Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="mt-1 py-2 font-mono uppercase" autoComplete="off" /></label>
        <label className="text-xs text-ink-400">E-mail<Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className="mt-1 py-2" autoComplete="username" /></label>
        <label className="text-xs text-ink-400">Contraseña (mínimo 10)<Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="mt-1 py-2" autoComplete="new-password" /></label>
        <label className="text-xs text-ink-400">Repetí la contraseña<Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} className="mt-1 py-2" autoComplete="new-password" /></label>
      </div>
      {err && <p className="mt-3 text-sm text-red-300" role="alert">{err}</p>}
      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" disabled={busy}>{busy ? "…" : "Crear y entrar"}</Button>
        <button type="button" className="text-sm text-ink-400 underline" onClick={() => setMode("login")}>Ya tengo usuario</button>
      </div>
    </form>
  );
}

function Keys() {
  const [status, setStatus] = useState<SecretStatus[] | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { backend.secretStatus().then(setStatus, (e) => setMsg({ ok: false, text: errText(e) })); }, []);
  const byName = new Map((status ?? []).map((s) => [s.name, s]));
  const dirty = Object.values(vals).some((v) => v.trim());

  return (
    <form className="rounded-2xl border border-ink-700 bg-ink-900 p-5" data-testid="keys" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMsg(null);
      try { setStatus(await backend.setSecrets(vals)); setVals({}); setMsg({ ok: true, text: "Guardado en el almacén cifrado de Supabase ✓ Los valores ya no se pueden ver desde acá." }); }
      catch (x) { setMsg({ ok: false, text: errText(x) }); } finally { setBusy(false); }
    }}>
      <h2 className="font-semibold text-white">Claves de integración</h2>
      <p className="mt-1 text-sm text-ink-400">Se guardan cifradas y son de solo escritura: después de guardar nadie puede volver a verlas (tampoco desde esta página). Dejá un campo vacío para no cambiarlo.</p>
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="mt-5">
          <legend className="text-sm font-semibold text-white">{g.title}</legend>
          <p className="text-xs text-ink-500">{g.hint}</p>
          <div className="mt-2 grid gap-2">
            {g.keys.map((k) => {
              const st = byName.get(k);
              return (
                <label key={k} className="grid gap-1 text-xs text-ink-400 sm:grid-cols-[14rem_1fr_auto] sm:items-center">
                  <span>{st?.label ?? k}</span>
                  <Input type={k === "LIVEKIT_URL" || k === "FLIGHTS_PROVIDER" || k === "MP_COLLECTOR_ID" ? "text" : "password"} autoComplete="off" spellCheck={false}
                    value={vals[k] ?? ""} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} aria-label={k}
                    placeholder={st?.set ? "✓ guardado — escribí para reemplazar" : k === "LIVEKIT_URL" ? "wss://…livekit.cloud" : k === "FLIGHTS_PROVIDER" ? "apimarket" : ""}
                    className={cx("py-2 font-mono text-xs", st?.set && "placeholder:text-emerald-300/80")} />
                  {k === "WHATSAPP_VERIFY_TOKEN"
                    ? <Button type="button" variant="ghost" className="py-1 text-xs" onClick={() => setVals({ ...vals, [k]: randomWord() })}>Generar</Button>
                    : <span className={cx("text-xs", st?.set ? "text-emerald-300" : "text-ink-600")}>{st?.set ? "✓" : "—"}</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      {msg && <p className={cx("mt-4 rounded-lg px-3 py-2 text-sm", msg.ok ? "bg-emerald-500/10 text-emerald-200" : "bg-red-500/10 text-red-200")} role="status">{msg.text}</p>}
      <Button type="submit" className="mt-4" disabled={busy || !dirty}>{busy ? "…" : "Guardar claves"}</Button>
    </form>
  );
}
