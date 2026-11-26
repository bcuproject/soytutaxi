import type { VehicleClass } from "./types.ts";

export const LARGE_BAG_UNITS = 2;
export const CARRY_ON_UNITS = 1;

export interface Load {
  passengers: number;
  largeBags: number;
  carryOn: number;
}

/**
 * Seat and baggage eligibility. Returns reason codes; empty array = eligible.
 * Uses seat capacity, separate large-bag and carry-on limits, and the optional joint bag-unit rule.
 */
export function eligibilityReasons(vc: VehicleClass, load: Load): string[] {
  const reasons: string[] = [];
  if (!vc.active) reasons.push("class_inactive");
  if (load.passengers > vc.maxPassengers) reasons.push("too_many_passengers");
  if (load.largeBags > vc.maxLargeBags) reasons.push("too_many_large_bags");
  if (load.carryOn > vc.maxCarryOn) reasons.push("too_many_carry_on");
  if (vc.maxBagUnits !== null) {
    const units = load.largeBags * LARGE_BAG_UNITS + load.carryOn * CARRY_ON_UNITS;
    if (units > vc.maxBagUnits) reasons.push("combined_baggage_exceeded");
  }
  return reasons;
}

export function isEligible(vc: VehicleClass, load: Load): boolean {
  return eligibilityReasons(vc, load).length === 0;
}

/** Active classes ordered by size (sortOrder), smallest first. */
export function orderedClasses(classes: VehicleClass[]): VehicleClass[] {
  return [...classes].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}
