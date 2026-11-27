// Meta WhatsApp Cloud API: webhook signature check, payload parsing and outbound message building.
// Same API and secret names as the BlackCabUnite project (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_VERIFY_TOKEN) plus WHATSAPP_APP_SECRET for the X-Hub-Signature-256 check.

export const GRAPH_VERSION = "v22.0";

export interface InboundMessage {
  id: string;
  from: string;              // wa_id (digits)
  profileName?: string;
  timestamp: number;         // unix seconds
  type: "text" | "reply" | "location" | "other";
  text?: string;
  replyId?: string;          // interactive button/list id, or quick-reply payload
  replyTitle?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  rawType: string;
}

export interface StatusUpdate {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient: string;
  error?: string;
}

export interface ParsedWebhook {
  phoneNumberId: string | null;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export type Outbound =
  | { type: "text"; text: string; previewUrl?: boolean }
  | { type: "buttons"; text: string; buttons: { id: string; title: string }[]; footer?: string }
  | { type: "list"; text: string; button: string; rows: { id: string; title: string; description?: string }[]; footer?: string }
  | { type: "template"; name: string; language: string; params: string[]; buttonPayloads?: string[] };

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verify Meta's X-Hub-Signature-256 over the exact raw request body. */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  return timingSafeEqual(sig, header.slice(7).toLowerCase());
}

// deno-lint-ignore no-explicit-any
type Any = any;

export function parseWebhook(body: Any): ParsedWebhook {
  const out: ParsedWebhook = { phoneNumberId: null, messages: [], statuses: [] };
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      if (v?.metadata?.phone_number_id) out.phoneNumberId = String(v.metadata.phone_number_id);
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c?.profile?.name ?? ""));
      for (const m of v.messages ?? []) {
        const from = String(m?.from ?? "").replace(/\D/g, "");
        if (!m?.id || !from) continue;
        const base = { id: String(m.id), from, profileName: names.get(from) || undefined, timestamp: Number(m.timestamp) || 0, rawType: String(m.type) };
        if (m.type === "text") {
          out.messages.push({ ...base, type: "text", text: String(m.text?.body ?? "").slice(0, 2000) });
        } else if (m.type === "interactive") {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          out.messages.push({ ...base, type: "reply", replyId: String(r?.id ?? ""), replyTitle: String(r?.title ?? "") });
        } else if (m.type === "button") {
          // Quick-reply button on a template message.
          out.messages.push({ ...base, type: "reply", replyId: String(m.button?.payload ?? ""), replyTitle: String(m.button?.text ?? "") });
        } else if (m.type === "location" && Number.isFinite(Number(m.location?.latitude))) {
          out.messages.push({
            ...base, type: "location",
            location: { lat: Number(m.location.latitude), lng: Number(m.location.longitude), name: m.location.name, address: m.location.address },
          });
        } else {
          out.messages.push({ ...base, type: "other" });
        }
      }
      for (const s of v.statuses ?? []) {
        if (!s?.id || !["sent", "delivered", "read", "failed"].includes(s.status)) continue;
        out.statuses.push({
          id: String(s.id), status: s.status, recipient: String(s.recipient_id ?? ""),
          error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title ?? s.errors[0].message ?? ""}` : undefined,
        });
      }
    }
  }
  return out;
}

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Build the Graph API /messages body. Enforces WhatsApp's size limits. */
export function toGraphPayload(to: string, m: Outbound): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (m.type) {
    case "text":
      return { ...base, type: "text", text: { body: cut(m.text, 4096), preview_url: !!m.previewUrl } };
    case "buttons":
      return {
        ...base, type: "interactive",
        interactive: {
          type: "button",
          body: { text: cut(m.text, 1024) },
          ...(m.footer ? { footer: { text: cut(m.footer, 60) } } : {}),
          action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: cut(b.id, 256), title: cut(b.title, 20) } })) },
        },
      };
    case "list":
      return {
        ...base, type: "interactive",
        interactive: {
          type: "list",
          body: { text: cut(m.text, 1024) },
          ...(m.footer ? { footer: { text: cut(m.footer, 60) } } : {}),
          action: {
            button: cut(m.button, 20),
            sections: [{ title: cut(m.button, 24), rows: m.rows.slice(0, 10).map((r) => ({ id: cut(r.id, 200), title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) }],
          },
        },
      };
    case "template":
      return {
        ...base, type: "template",
        template: {
          name: m.name, language: { code: m.language },
          components: [
            ...(m.params.length ? [{ type: "body", parameters: m.params.map((t) => ({ type: "text", text: cut(t, 1000) })) }] : []),
            ...(m.buttonPayloads ?? []).map((p, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: p }] })),
          ],
        },
      };
  }
}

/** Plain-text rendering, stored as the message preview in the dispatch inbox. */
export function previewOf(m: Outbound): string {
  switch (m.type) {
    case "text": return m.text;
    case "buttons": return `${m.text}\n[${m.buttons.map((b) => b.title).join("] [")}]`;
    case "list": return `${m.text}\n▸ ${m.button}: ${m.rows.map((r) => r.title).join(" · ")}`;
    case "template": return `(plantilla ${m.name}) ${m.params.join(" · ")}`;
  }
}

export interface Sender {
  send(to: string, m: Outbound): Promise<{ id?: string; error?: string }>;
}

/** Real sender for the Graph API. */
export function graphSender(phoneNumberId: string, accessToken: string, fetchImpl: typeof fetch = fetch): Sender {
  return {
    async send(to, m) {
      try {
        const r = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(toGraphPayload(to, m)),
          signal: AbortSignal.timeout(10_000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: `${r.status} ${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`.trim().slice(0, 300) };
        return { id: j?.messages?.[0]?.id };
      } catch (e) {
        return { error: `network: ${(e as Error).message}`.slice(0, 300) };
      }
    },
  };
}
