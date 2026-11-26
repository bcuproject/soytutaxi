import type { Direction, FareBreakdown, FareRule } from "./types.ts";

export interface FareQuery {
  direction: Direction;
  airportId: string;
  zoneId: string;
  vehicleClass: string;
  /** Local pickup date YYYY-MM-DD (fare effective dates are local). */
  pickupLocalDate: string;
}

export type FareMatch =
  | { ok: true; rule: FareRule; fare: FareBreakdown }
  | { ok: false; reason: "no_fare_rule" | "ambiguous_fare_rules"; candidates: string[] };

function effectiveOn(rule: FareRule, date: string): boolean {
  return rule.effectiveFrom <= date && (rule.effectiveTo === null || date < rule.effectiveTo);
}

/**
 * Select the governing fare rule.
 * Ordering: lowest rank, then zone-specific before generic. If the best two candidates tie on both,
 * the configuration is ambiguous and the journey falls back to a manual quote.
 */
export function matchFare(rules: FareRule[], q: FareQuery): FareMatch {
  const candidates = rules.filter((r) =>
    r.active &&
    r.direction === q.direction &&
    r.airportId === q.airportId &&
    r.vehicleClass === q.vehicleClass &&
    (r.zoneId === null || r.zoneId === q.zoneId) &&
    effectiveOn(r, q.pickupLocalDate)
  );
  if (candidates.length === 0) return { ok: false, reason: "no_fare_rule", candidates: [] };

  const specificity = (r: FareRule) => (r.zoneId === null ? 1 : 0);
  candidates.sort((a, b) => a.rank - b.rank || specificity(a) - specificity(b) || a.id.localeCompare(b.id));

  const [best, second] = candidates;
  if (second && second.rank === best.rank && specificity(second) === specificity(best)) {
    return { ok: false, reason: "ambiguous_fare_rules", candidates: candidates.map((c) => c.id) };
  }

  return {
    ok: true,
    rule: best,
    fare: {
      baseMinor: best.amountMinor,
      taxesMinor: best.taxesMinor,
      totalMinor: best.amountMinor + best.taxesMinor,
      currency: best.currency,
      fareRuleId: best.id,
      fareRuleVersion: best.version,
      estDurationMin: best.estDurationMin,
      isDemo: best.isDemo,
    },
  };
}

/** Format minor units for display (USD 30.00 / ARS 45.000,00). */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "es-AR", {
    style: "currency", currency, currencyDisplay: "code",
  }).format(amountMinor / 100);
}
