// Mercado Pago Checkout Pro: hosted checkout preferences, verified notifications, payment lookup, refunds.

const API = "https://api.mercadopago.com";
const enc = new TextEncoder();

/**
 * x-signature check. Manifest: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (missing pairs are left out),
 * HMAC-SHA256 hex with the webhook secret, compared in constant time.
 */
export async function verifyMpSignature(xSignature: string | null, xRequestId: string | null, dataId: string | null, secret: string,
  now = Date.now(), maxAgeMs = 15 * 60_000): Promise<boolean> {
  if (!xSignature || !secret) return false;
  const parts = Object.fromEntries(xSignature.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const ts = parts.ts, v1 = parts.v1;
  if (!ts || !v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const tsMs = ts.length > 11 ? Number(ts) : Number(ts) * 1000;      // seconds or milliseconds
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > maxAgeMs) return false;
  const id = dataId ? (/[a-z]/i.test(dataId) ? dataId.toLowerCase() : dataId) : null;
  const manifest = `${id ? `id:${id};` : ""}${xRequestId ? `request-id:${xRequestId};` : ""}ts:${ts};`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(manifest)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  let diff = mac.length ^ v1.length;
  for (let i = 0; i < mac.length && i < v1.length; i++) diff |= mac.charCodeAt(i) ^ v1.toLowerCase().charCodeAt(i);
  return diff === 0;
}

export interface MpPayment { id: string; status: string; amountMinor: number; currency: string; externalReference: string | null; approvedAt: string | null; collectorId: string | null }

export interface MercadoPago {
  createPreference(a: { attemptId: string; title: string; amountMinor: number; currency: string; payerName?: string;
    notificationUrl: string; backUrl: string; expiresAt: string }): Promise<{ id: string; url: string }>;
  getPayment(id: string): Promise<MpPayment | null>;
  refund(paymentId: string, amountMinor: number, idempotencyKey: string): Promise<{ id: string; status: string }>;
}

export function mercadoPago(accessToken: string, fetchImpl: typeof fetch = fetch): MercadoPago {
  const sandbox = accessToken.startsWith("TEST-");
  async function call(method: string, path: string, body?: unknown, idem?: string) {
    const r = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(idem ? { "X-Idempotency-Key": idem } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`mp_${r.status}: ${String(j?.message ?? "").slice(0, 160)}`);
    return j;
  }
  return {
    async createPreference(a) {
      const j = await call("POST", "/checkout/preferences", {
        items: [{ id: a.attemptId, title: a.title.slice(0, 250), quantity: 1, currency_id: a.currency, unit_price: a.amountMinor / 100 }],
        external_reference: a.attemptId,
        notification_url: a.notificationUrl,
        back_urls: { success: a.backUrl, pending: a.backUrl, failure: a.backUrl },
        auto_return: "approved",
        binary_mode: true,                         // approved or rejected, no long "pending" cards
        expires: true, expiration_date_to: a.expiresAt,
        statement_descriptor: "SOYTUTAXI",
        ...(a.payerName ? { payer: { name: a.payerName.slice(0, 80) } } : {}),
      }, `pref-${a.attemptId}`);
      return { id: String(j.id), url: String(sandbox && j.sandbox_init_point ? j.sandbox_init_point : j.init_point) };
    },
    async getPayment(id) {
      const j = await call("GET", `/v1/payments/${encodeURIComponent(id)}`);
      if (!j) return null;
      return { id: String(j.id), status: String(j.status), amountMinor: Math.round(Number(j.transaction_amount) * 100),
        currency: String(j.currency_id), externalReference: j.external_reference ? String(j.external_reference) : null,
        approvedAt: j.date_approved ?? null, collectorId: j.collector_id != null ? String(j.collector_id) : null };
    },
    async refund(paymentId, amountMinor, idempotencyKey) {
      const j = await call("POST", `/v1/payments/${encodeURIComponent(paymentId)}/refunds`, { amount: amountMinor / 100 }, idempotencyKey);
      return { id: String(j?.id ?? ""), status: String(j?.status ?? "") };
    },
  };
}
