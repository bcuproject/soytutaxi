// Despacho → WhatsApp → ⚙️ Conexión: connect the SoyTuTaxi WhatsApp number (admin only).
// Every step runs on the server with the access token stored in Supabase; this screen never sees it.
// The SMS code and the PIN are typed here by the admin and go straight to Meta.
import { useEffect, useState } from "react";
import { backend, CommandError } from "../lib/backend";
import { cx } from "../lib/format";
import { Button, Input } from "./ui";

type Status = Record<string, any>;
const ERR: Record<string, string> = {
  forbidden: "Solo un administrador puede configurar la conexión.", unauthenticated: "Iniciá sesión como administrador.",
  token_missing: "Falta el secreto WHATSAPP_ACCESS_TOKEN en Supabase.", verify_token_missing: "Falta el secreto WHATSAPP_VERIFY_TOKEN en Supabase.",
  invalid_code: "El código tiene 6 números.", invalid_pin: "El PIN tiene 6 números.", invalid_number: "Revisá el código de país, el número y el nombre.",
  waba_required: "Elegí la cuenta de WhatsApp Business.", phone_required: "Elegí o agregá el número.", live_only: "Disponible solo en modo en vivo.",
};
const Dot = ({ ok }: { ok: boolean | null }) => <span className={cx("inline-block h-2.5 w-2.5 rounded-full", ok == null ? "bg-ink-600" : ok ? "bg-emerald-400" : "bg-red-400")} />;

export function WhatsAppSetup() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [waba, setWaba] = useState("");
  const [num, setNum] = useState({ countryCode: "54", phoneNumber: "", displayName: "SoyTuTaxi" });
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");

  async function run(action: string, args: Record<string, unknown> = {}, ok?: string) {
    setBusy(action); setMsg(null);
    try {
      const r = await backend.waSetup(action, { wabaId: waba || undefined, ...args });
      if (action === "status") setSt(r); else { if (ok) setMsg({ ok: true, text: ok }); setSt(await backend.waSetup("status", { wabaId: waba || undefined })); }
      return r;
    } catch (e) {
      const c = e instanceof CommandError ? e.code : "";
      setMsg({ ok: false, text: c === "meta_error" ? `Meta respondió: ${(e as Error).message}` : ERR[c] ?? (e as Error).message });
      return null;
    } finally { setBusy(null); }
  }
  useEffect(() => { run("status"); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (st && !waba) setWaba(st.selected?.wabaId || st.accounts?.[0]?.id || ""); }, [st, waba]);

  const sec = st?.secrets ?? {};
  const account = st?.accounts?.find((a: any) => a.id === waba);
  const numbers: any[] = account?.phoneNumbers ?? [];
  const current = numbers.find((n) => n.id === st?.connected?.phoneNumberId);
  const ourHook = current?.webhook_configuration?.phone_number === st?.callbackUrl;
  const calling = st?.calling?.status === "ENABLED";

  return (
    <div className="mb-4 rounded-2xl border border-ink-700 bg-ink-900 p-4 text-sm" data-testid="wa-setup">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white">Conexión de WhatsApp</h3>
        <Button variant="ghost" className="py-1" disabled={!!busy} onClick={() => run("status")}>{busy === "status" ? "…" : "Actualizar"}</Button>
      </div>

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        <span className="flex items-center gap-2"><Dot ok={st ? !!sec.accessToken && !!st.tokenValid : null} /> Token de acceso {st?.tokenValid === false && "(inválido o vencido)"}</span>
        <span className="flex items-center gap-2"><Dot ok={st ? !!sec.appSecret : null} /> App secret (firma de Meta)</span>
        <span className="flex items-center gap-2"><Dot ok={st ? !!sec.verifyToken : null} /> Verify token</span>
        <span className="flex items-center gap-2"><Dot ok={st ? !!sec.liveKit : null} /> LiveKit (Sofía y transferencias)</span>
        <span className="flex items-center gap-2"><Dot ok={st ? !!current : null} /> Número conectado {current && `· ${current.display_phone_number}`}</span>
        <span className="flex items-center gap-2"><Dot ok={st && current ? ourHook : null} /> Webhook del número → SoyTuTaxi</span>
        <span className="flex items-center gap-2"><Dot ok={st && current ? calling : null} /> Llamadas de WhatsApp activadas</span>
        <span className="flex items-center gap-2"><Dot ok={st ? (st.connected?.templates ?? 0) > 0 : null} /> Plantillas ({st?.connected?.templates ?? 0})</span>
      </div>
      {st && !sec.appSecret && <p className="mt-2 text-xs text-amber-300">Sin el App secret, SoyTuTaxi rechaza todos los mensajes entrantes (no puede comprobar que vienen de Meta). Pedíselo a quien administra la app de Meta y cargalo en Supabase como WHATSAPP_APP_SECRET.</p>}

      {(st?.accounts?.length ?? 0) > 0 && (
        <label className="mt-4 block text-xs text-ink-400">Cuenta de WhatsApp Business
          <select value={waba} onChange={(e) => setWaba(e.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm">
            {st!.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name ?? a.id} · {a.id}</option>)}
          </select>
        </label>
      )}

      {numbers.length > 0 && (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-ink-400">Números de esa cuenta</div>
          {numbers.map((n) => (
            <div key={n.id} className="flex flex-wrap items-center gap-2 border-b border-ink-800 py-1.5 last:border-0">
              <span className="font-medium text-white">{n.display_phone_number}</span>
              <span className="text-xs text-ink-400">{n.verified_name} · {n.code_verification_status} · {n.status ?? ""} · calidad {n.quality_rating ?? "—"}</span>
              {n.id === st?.connected?.phoneNumberId ? <span className="ml-auto text-xs text-emerald-300">SoyTuTaxi ✓</span>
                : n.webhook_configuration?.phone_number && n.webhook_configuration.phone_number !== st?.callbackUrl
                  ? <span className="ml-auto text-xs text-ink-500">usado por otro sistema</span>
                  : <Button variant="outline" className="ml-auto py-1 text-xs" disabled={!!busy}
                      onClick={() => run("use_number", { phoneNumberId: n.id }, "Número elegido para SoyTuTaxi.")}>Usar para SoyTuTaxi</Button>}
            </div>
          ))}
        </div>
      )}

      <details className="mt-4 rounded-xl border border-ink-800 p-3" open={!!st && !current}>
        <summary className="cursor-pointer font-medium text-white">1 · Agregar un número nuevo</summary>
        <p className="mt-1 text-xs text-ink-400">El número no puede estar en la app de WhatsApp (borrá la cuenta de ese teléfono antes) y tiene que poder recibir un SMS o una llamada.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Input value={num.countryCode} onChange={(e) => setNum({ ...num, countryCode: e.target.value })} className="w-20 py-2" aria-label="Código de país" placeholder="54" />
          <Input value={num.phoneNumber} onChange={(e) => setNum({ ...num, phoneNumber: e.target.value })} className="w-48 py-2" aria-label="Número" placeholder="9 11 5555 1234" />
          <Input value={num.displayName} onChange={(e) => setNum({ ...num, displayName: e.target.value })} className="w-48 py-2" aria-label="Nombre visible" />
          <Button className="py-2" disabled={!!busy || !waba} onClick={() => run("add_number", num, "Número agregado. Ahora pedí el código.")}>Agregar</Button>
        </div>
        <p className="mt-1 text-xs text-ink-500">Meta revisa el nombre visible ("SoyTuTaxi"); mientras tanto el número ya puede usarse.</p>
      </details>

      <details className="mt-2 rounded-xl border border-ink-800 p-3" open={!!current && current.code_verification_status !== "VERIFIED"}>
        <summary className="cursor-pointer font-medium text-white">2 · Verificar y registrar el número</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Button variant="outline" className="py-2" disabled={!!busy || !current} onClick={() => run("request_code", { method: "SMS" }, "Te mandamos un SMS con el código.")}>Enviar código por SMS</Button>
          <Button variant="ghost" className="py-2" disabled={!!busy || !current} onClick={() => run("request_code", { method: "VOICE" }, "Te llamamos para dictarte el código.")}>…o por llamada</Button>
          <Input value={code} onChange={(e) => setCode(e.target.value)} className="w-32 py-2" inputMode="numeric" placeholder="Código" aria-label="Código de verificación" autoComplete="one-time-code" />
          <Button className="py-2" disabled={!!busy || code.replace(/\D/g, "").length !== 6} onClick={async () => { if (await run("verify_code", { code }, "Número verificado ✓")) setCode(""); }}>Verificar</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Input value={pin} onChange={(e) => setPin(e.target.value)} className="w-40 py-2" inputMode="numeric" type="password" placeholder="PIN de 6 números" aria-label="PIN" autoComplete="new-password" />
          <Button className="py-2" disabled={!!busy || pin.replace(/\D/g, "").length !== 6} onClick={async () => { if (await run("register", { pin }, "Número registrado en WhatsApp ✓")) setPin(""); }}>Registrar</Button>
        </div>
        <p className="mt-1 text-xs text-ink-500">El PIN es la verificación en dos pasos del número: elegilo vos y guardalo; SoyTuTaxi no lo guarda.</p>
      </details>

      <details className="mt-2 rounded-xl border border-ink-800 p-3" open={!!current && (!ourHook || !calling)}>
        <summary className="cursor-pointer font-medium text-white">3 · Conectar con SoyTuTaxi</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button className="py-2" disabled={!!busy || !current} onClick={() => run("webhook", {}, "Los mensajes y llamadas de este número ahora llegan a SoyTuTaxi ✓")}>Recibir mensajes y llamadas</Button>
          <Button variant="outline" className="py-2" disabled={!!busy || !current} onClick={() => run("calling", { enable: true }, "Llamadas de WhatsApp activadas ✓")}>Activar llamadas</Button>
          <Button variant="outline" className="py-2" disabled={!!busy || !waba} onClick={() => run("templates", {}, "Plantillas enviadas a Meta para aprobación.")}>Crear plantillas</Button>
        </div>
        <p className="mt-1 text-xs text-ink-500">Solo cambia este número: las otras líneas de la cuenta siguen igual. Para llamadas, Meta exige un límite de mensajería de 2.000 por día o más.</p>
      </details>

      {msg && <p className={cx("mt-3 rounded-lg px-3 py-2 text-sm", msg.ok ? "bg-emerald-500/10 text-emerald-200" : "bg-red-500/10 text-red-200")} role="status">{msg.text}</p>}
    </div>
  );
}
