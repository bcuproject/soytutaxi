// Map database rows (snake_case) to the domain OperatorConfig. Shared by the Supabase store and
// the Node integration tests so both read configuration identically.

import type { OperatorConfig } from "../domain/types.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** daterange text '[2026-01-01,)' → { from, to }. */
export function parseDateRange(r: string): { from: string; to: string | null } {
  const m = /^[[(]([^,]*),([^)\]]*)[)\]]$/.exec(r.trim());
  if (!m) throw new Error(`bad daterange ${r}`);
  return { from: m[1] || "0001-01-01", to: m[2] ? m[2] : null };
}

export function rowsToConfig(op: Row, vc: Row[], ap: Row[], zn: Row[], fr: Row[], pol: Row): OperatorConfig {
  return {
    operatorId: op.id,
    slug: op.slug,
    name: op.name,
    timezone: op.timezone,
    demoMode: op.demo_mode,
    vehicleClasses: vc.map((v) => ({
      code: v.code, labelEs: v.label_es, labelEn: v.label_en, maxPassengers: v.max_passengers,
      maxLargeBags: v.max_large_bags, maxCarryOn: v.max_carry_on, maxBagUnits: v.max_bag_units,
      sortOrder: v.sort_order, active: v.active,
    })),
    airports: ap.map((a) => ({
      id: a.id, iata: a.iata, name: a.name, meetingPointEs: a.meeting_point_es, meetingPointEn: a.meeting_point_en,
      lat: a.lat, lng: a.lng, active: a.active,
    })),
    zones: zn.map((z) => ({ id: z.id, code: z.code, name: z.name, polygon: z.polygon, active: z.active })),
    fareRules: fr.map((f) => {
      const eff = parseDateRange(String(f.effective));
      return {
        id: f.id, direction: f.direction, airportId: f.airport_id, zoneId: f.zone_id, vehicleClass: f.vehicle_class,
        rank: f.rank, amountMinor: Number(f.amount_minor), taxesMinor: Number(f.taxes_minor), currency: f.currency,
        estDurationMin: f.est_duration_min, effectiveFrom: eff.from, effectiveTo: eff.to, version: f.version,
        active: f.active, isDemo: f.is_demo,
      };
    }),
    policy: { id: pol.id, version: pol.version, label: pol.label, isDemo: pol.is_demo, config: pol.config },
  };
}
