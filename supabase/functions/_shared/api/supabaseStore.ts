// Store backed by Supabase (service role). Deno-only: imported by supabase/functions/api/index.ts.
// Business transactions run inside PostgreSQL functions; this adapter only maps rows and errors.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { OperatorConfig } from "../domain/types.ts";
import { ApiError, type Actor, type BookingStatusView, type CreateBookingArgs, type QuoteRow, type Store } from "./store.ts";
import { rowsToConfig } from "./configMapping.ts";

const CONFIG_TTL_MS = 60_000;

export class SupabaseStore implements Store {
  private db: SupabaseClient;
  private cache: { at: number; slug: string; cfg: OperatorConfig } | null = null;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async loadConfig(slug: string): Promise<OperatorConfig | null> {
    if (this.cache && this.cache.slug === slug && Date.now() - this.cache.at < CONFIG_TTL_MS) return this.cache.cfg;
    const { data: op, error } = await this.db.from("operators").select("*").eq("slug", slug).maybeSingle();
    if (error) throw error;
    if (!op) return null;
    const [vc, ap, zn, fr, pol] = await Promise.all([
      this.db.from("vehicle_classes").select("*").eq("operator_id", op.id),
      this.db.from("airports").select("*").eq("operator_id", op.id),
      this.db.from("zones").select("*").eq("operator_id", op.id),
      this.db.from("fare_rules").select("*").eq("operator_id", op.id).eq("active", true),
      this.db.from("policies").select("*").eq("operator_id", op.id).lte("effective_from", new Date().toISOString())
        .order("version", { ascending: false }).limit(1).maybeSingle(),
    ]);
    for (const r of [vc, ap, zn, fr, pol]) if (r.error) throw r.error;
    if (!pol.data) return null;
    const cfg = rowsToConfig(op, vc.data!, ap.data!, zn.data!, fr.data!, pol.data);
    this.cache = { at: Date.now(), slug, cfg };
    return cfg;
  }

  async insertQuote(row: QuoteRow) {
    const j = row.journey;
    const { data, error } = await this.db.from("quotes").insert({
      operator_id: row.operatorId,
      session_hash: row.sessionHash,
      source: row.source,
      kind: row.kind,
      direction: j.direction,
      airport_id: j.airportId,
      zone_id: j.zoneId,
      vehicle_class: row.vehicleClass,
      passengers: j.passengers,
      large_bags: j.largeBags,
      carry_on: j.carryOn,
      pickup_at: j.pickupAt,
      journey: j,
      fare: row.fare,
      amount_minor: row.fare?.totalMinor ?? null,
      currency: row.fare?.currency ?? null,
      fare_rule_id: row.fare?.fareRuleId ?? null,
      fare_rule_version: row.fare?.fareRuleVersion ?? null,
      policy_id: row.policyId,
      manual_reasons: row.manualReasons,
      expires_at: row.expiresAt,
    }).select("id").single();
    if (error) throw error;
    return { id: data.id as string };
  }

  async createBooking(a: CreateBookingArgs) {
    const { data, error } = await this.db.rpc("create_booking_from_quote", {
      p_operator_id: a.operatorId,
      p_quote_id: a.quoteId,
      p_session_hash: a.sessionHash,
      p_idempotency_key: a.idempotencyKey,
      p_request_hash: a.requestHash,
      p_contact: a.contact,
      p_payment_mode: a.paymentMode,
      p_notes: a.notes,
      p_status_token_hash: a.statusTokenHash,
      p_actor_id: a.actorId,
      p_flight_exception_reason: a.flightExceptionReason,
      p_request_id: a.requestId,
    });
    if (error) throw mapPgError(error);
    return { bookingId: data.booking_id, reference: data.reference, state: data.state, replay: data.replay };
  }

  async getBookingStatus(reference: string, tokenHash: string) {
    const { data, error } = await this.db.rpc("get_booking_status", { p_reference: reference, p_status_token_hash: tokenHash });
    if (error) throw mapPgError(error);
    return (data ?? null) as BookingStatusView | null;
  }

  async cancelTerms(reference: string, tokenHash: string) {
    const { data, error } = await this.db.rpc("passenger_cancel_preview", { p_reference: reference, p_token_hash: tokenHash });
    if (error) throw mapPgError(error);
    return data;
  }

  async cancelBooking(reference: string, tokenHash: string, reason: string | null) {
    const { data, error } = await this.db.rpc("passenger_cancel", { p_reference: reference, p_token_hash: tokenHash, p_reason: reason });
    if (error) throw mapPgError(error);
    return data;
  }

  async rateBooking(reference: string, tokenHash: string, score: number, comment: string | null) {
    const { data, error } = await this.db.rpc("passenger_rate", { p_reference: reference, p_token_hash: tokenHash, p_score: score, p_comment: comment });
    if (error) throw mapPgError(error);
    return data;
  }

  async resolveActor(bearer: string, operatorId: string): Promise<Actor | null> {
    const { data, error } = await this.db.auth.getUser(bearer);
    if (error || !data?.user) return null; // anon key or expired token → public caller
    const { data: rows } = await this.db.from("memberships").select("role")
      .eq("operator_id", operatorId).eq("user_id", data.user.id).eq("active", true);
    const roles = (rows ?? []).map((r: { role: Actor["roles"][number] }) => r.role);
    return roles.length ? { userId: data.user.id, roles } : null;
  }
}

/** Business errors are raised by app.fail(code, status) → MESSAGE=code, DETAIL=status. */
export function mapPgError(e: { code?: string; message?: string; details?: string | null; hint?: string | null }): Error {
  if (e.code === "P0001" && e.message) {
    const status = Number(e.details) || 422;
    return new ApiError(status, e.message, e.hint ?? e.message);
  }
  if (e.code === "23P01") return new ApiError(409, "schedule_conflict", "Driver or vehicle already has an overlapping job.");
  return new Error(`db_error:${e.code ?? "unknown"}`);
}
