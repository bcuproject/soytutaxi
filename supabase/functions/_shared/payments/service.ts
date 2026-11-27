// Payments orchestration (Deno-free so it can be tested): checkout links, verified notifications, refunds.
import { sha256Hex } from "../domain/crypto.ts";
import { ApiError } from "../api/store.ts";
import type { MercadoPago } from "./mercadopago.ts";

export interface PayDb {
  checkoutContext(reference: string, tokenHash: string): Promise<{
    bookingId: string; reference: string; state: string; amountMinor: number; currency: string; fareAmountMinor: number;
    fareCurrency: string; fxRate: number; expiresAt: string; locale: string; reuse: { attemptId: string; checkoutUrl: string } | null;
  }>;
  createAttempt(bookingId: string, amount: number, currency: string, fareAmount: number, fareCurrency: string, fx: number, expiresAt: string): Promise<string>;
  attemptReady(attemptId: string, preferenceId: string | null, url: string | null, ok: boolean): Promise<void>;
  record(attemptId: string, paymentId: string, status: string, amountMinor: number, currency: string, approvedAt: string | null): Promise<{ outcome: string }>;
  inboxClaim(key: string): Promise<boolean>;
  inboxDone(key: string): Promise<void>;
  outboxClaim(limit: number): Promise<{ id: string; kind: string; payload: Record<string, unknown> }[]>;
  outboxFinish(jobId: string, ok: boolean, error: string | null, final: boolean): Promise<void>;
  refundContext(refundId: string): Promise<{ refundId: string; state: string; amountMinor: number; providerPaymentId: string } | null>;
  refundSet(refundId: string, state: string, providerRefundId: string | null, error: string | null): Promise<void>;
}

export interface PayDeps {
  db: PayDb; mp: MercadoPago | null; publicAppUrl: string; notificationUrl: string; collectorId?: string | null;
  log?: (o: Record<string, unknown>) => void;
}

/** Passenger presses "Pagar": reuse a live checkout or create one for the locked amount. */
export async function checkout(deps: PayDeps, reference: string, token: string): Promise<{ url: string }> {
  if (!deps.mp) throw new ApiError(503, "payments_not_configured", "Mercado Pago is not configured");
  if (!/^STT-[A-Z0-9]{6}$/i.test(reference) || token.length < 20) throw new ApiError(404, "booking_not_found", "not found");
  const c = await deps.db.checkoutContext(reference, await sha256Hex(token));
  if (c.reuse) return { url: c.reuse.checkoutUrl };
  const attemptId = await deps.db.createAttempt(c.bookingId, c.amountMinor, c.currency, c.fareAmountMinor, c.fareCurrency, c.fxRate, c.expiresAt);
  try {
    const p = await deps.mp.createPreference({
      attemptId, title: `SoyTuTaxi ${c.reference} · traslado aeropuerto`, amountMinor: c.amountMinor, currency: c.currency,
      notificationUrl: deps.notificationUrl, backUrl: `${deps.publicAppUrl.replace(/\/$/, "")}/reserva/${c.reference}?t=${encodeURIComponent(token)}&pago=1`,
      expiresAt: c.expiresAt,
    });
    await deps.db.attemptReady(attemptId, p.id, p.url, true);
    return { url: p.url };
  } catch (e) {
    // Creation result uncertain: mark failed; the next press creates a fresh attempt (MP idempotency key per attempt).
    await deps.db.attemptReady(attemptId, null, null, false);
    deps.log?.({ level: "error", where: "mp-preference", error: String((e as Error).message).slice(0, 200) });
    throw new ApiError(502, "payment_provider_error", "Mercado Pago did not answer");
  }
}

/** Verified notification → authoritative payment from Mercado Pago → recorded. The return page never marks paid. */
export async function notification(deps: PayDeps, n: { type: string | null; dataId: string | null; requestId: string | null }): Promise<string> {
  if (!deps.mp) return "not_configured";
  if (n.type !== "payment" || !n.dataId || !/^\d{1,20}$/.test(n.dataId)) return "ignored";
  const key = `mp:${n.dataId}:${n.requestId ?? "-"}`;
  if (!(await deps.db.inboxClaim(key))) return "duplicate";
  try {
    const p = await deps.mp.getPayment(n.dataId);
    if (!p) return "not_found";
    if (!p.externalReference || !/^[0-9a-f-]{36}$/.test(p.externalReference)) return "foreign_payment";
    if (deps.collectorId && p.collectorId && p.collectorId !== deps.collectorId) return "wrong_merchant";
    const r = await deps.db.record(p.externalReference, p.id, p.status, p.amountMinor, p.currency, p.approvedAt);
    return r.outcome;
  } finally {
    await deps.db.inboxDone(key);
  }
}

/** Refund jobs: submit once (idempotency key = refund id), then confirm the provider's answer. */
export async function processPaymentJobs(deps: PayDeps): Promise<{ done: number; failed: number }> {
  let done = 0, failed = 0;
  for (const job of await deps.db.outboxClaim(10)) {
    try {
      if (job.kind !== "payment.refund") { await deps.db.outboxFinish(job.id, true, "unknown_kind", false); continue; }
      const r = await deps.db.refundContext(String(job.payload.refund_id));
      if (!r || r.state === "completed") { await deps.db.outboxFinish(job.id, true, null, false); continue; }
      if (!deps.mp) { await deps.db.outboxFinish(job.id, false, "payments_not_configured", false); failed++; continue; }
      await deps.db.refundSet(r.refundId, "pending", null, null);
      const res = await deps.mp.refund(r.providerPaymentId, r.amountMinor, `refund-${r.refundId}`);
      const ok = res.status === "approved";
      await deps.db.refundSet(r.refundId, ok ? "completed" : "pending", res.id || null, ok ? null : `status ${res.status}`);
      await deps.db.outboxFinish(job.id, ok, ok ? null : `status ${res.status}`, false);
      ok ? done++ : failed++;
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 200);
      const permanent = /^mp_4\d\d/.test(msg) && !/^mp_429/.test(msg);
      if (permanent) await deps.db.refundSet(String(job.payload.refund_id), "failed", null, msg);
      await deps.db.outboxFinish(job.id, false, msg, permanent);
      failed++;
    }
  }
  return { done, failed };
}
