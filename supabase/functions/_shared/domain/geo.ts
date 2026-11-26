import type { Ring, Zone } from "./types.ts";

/** Ray-casting point-in-polygon on [lng, lat] rings (outer ring only). */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInZone(lng: number, lat: number, zone: Zone): boolean {
  return zone.polygon.length > 0 && pointInRing(lng, lat, zone.polygon[0]);
}

/** All active zones containing the point (zones may legitimately touch or overlap at borders). */
export function zonesContaining(lng: number, lat: number, zones: Zone[]): Zone[] {
  return zones.filter((z) => z.active && pointInZone(lng, lat, z));
}

export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
