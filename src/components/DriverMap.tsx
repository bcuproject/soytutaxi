import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { BoardRow } from "../lib/backend";
import { fmtTime } from "../lib/format";

export const STATUS_COLOR: Record<BoardRow["mapStatus"], string> = {
  free: "#22c55e",       // libre
  to_pickup: "#f5c400",  // yendo a buscar
  onboard: "#3b82f6",    // con pasajero
  stale: "#9ca3af",      // sin señal reciente
  off: "#4b5563",
};
export const STATUS_ES: Record<BoardRow["mapStatus"], string> = {
  free: "Libre", to_pickup: "Yendo a buscar", onboard: "Con pasajero", stale: "Sin señal", off: "Fuera de turno",
};

const AIRPORTS = [
  { iata: "EZE", lat: -34.8222, lng: -58.5358 },
  { iata: "AEP", lat: -34.5592, lng: -58.4156 },
];

function carIcon(r: BoardRow, selected: boolean): L.DivIcon {
  const c = STATUS_COLOR[r.mapStatus];
  const rot = r.heading ?? 0;
  const initials = r.fullName.split(/\s+/).map((w) => w[0]).slice(0, 2).join("");
  // Text comes from our own driver records but is still escaped before entering HTML.
  const safe = initials.replace(/[&<>"']/g, "");
  return L.divIcon({
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div style="position:relative;width:34px;height:34px">
      ${r.heading !== null && r.mapStatus !== "stale" ? `<div style="position:absolute;left:13px;top:-7px;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:9px solid ${c};transform-origin:4px 24px;transform:rotate(${rot}deg)"></div>` : ""}
      <div style="width:34px;height:34px;border-radius:50%;background:${c};border:3px solid ${selected ? "#fff" : "#0a0a0a"};box-shadow:0 2px 8px rgba(0,0,0,.6);display:grid;place-items:center;font:700 11px Inter,system-ui;color:#0a0a0a;${r.mapStatus === "stale" ? "opacity:.6" : ""}">${safe}</div>
    </div>`,
  });
}

export function DriverMap({ rows, selectedId, onSelect, height = 560 }: {
  rows: BoardRow[]; selectedId?: string | null; onSelect?: (driverId: string) => void; height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { zoomControl: true, attributionControl: true }).setView([-34.66, -58.47], 11);
    // Standard OpenStreetMap tiles (light use, attribution required); darkened in CSS (.stt-dark-tiles).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "stt-dark-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    for (const a of AIRPORTS) {
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({ className: "", iconSize: [44, 22], iconAnchor: [22, 11],
          html: `<div style="background:#0a0a0a;border:1px solid #f5c400;color:#f5c400;border-radius:6px;font:700 11px JetBrains Mono,monospace;text-align:center;line-height:20px">✈ ${a.iata}</div>` }),
        interactive: false,
      }).addTo(m);
    }
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts: L.LatLngExpression[] = [];
    for (const r of rows) {
      if (r.lat === null || r.lng === null) continue;
      pts.push([r.lat, r.lng]);
      const mk = L.marker([r.lat, r.lng], { icon: carIcon(r, r.driverId === selectedId), title: r.fullName, zIndexOffset: r.driverId === selectedId ? 1000 : 0 });
      const tip = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = r.fullName; tip.appendChild(name);
      const line = document.createElement("div");
      line.textContent = `${STATUS_ES[r.mapStatus]}${r.vehiclePlate ? " · " + r.vehiclePlate : ""}${r.currentReference ? " · " + r.currentReference : ""}${r.recordedAt ? " · " + fmtTime(r.recordedAt) : ""}`;
      tip.appendChild(line);
      mk.bindTooltip(tip, { direction: "top", offset: [0, -16] });
      if (onSelect) mk.on("click", () => onSelect(r.driverId));
      mk.addTo(g);
    }
    if (!fitted.current && pts.length) {
      m.fitBounds(L.latLngBounds([...pts, ...AIRPORTS.map((a) => [a.lat, a.lng] as L.LatLngExpression)]).pad(0.15));
      fitted.current = true;
    }
  }, [rows, selectedId, onSelect]);

  return <div ref={box} style={{ height }} className="z-0 w-full overflow-hidden rounded-2xl border border-ink-800" data-testid="driver-map" />;
}
