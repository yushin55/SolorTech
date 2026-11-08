import { useEffect, useRef } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Candidate, Plant } from "./types";
import { num } from "./api";

type Point = { latitude: number; longitude: number };
type Props = {
  plants: Plant[];
  candidates: Candidate[];
  selectedCandidateId: string;
  picked: Point | null;
  onPlant: (plant: Plant) => void;
  onCandidate: (id: string) => void;
  onPoint: (point: Point) => void;
};

const PLANT_COLOR: Record<string, string> = {
  floating: "#0d9488",
  plant: "#2563eb",
  basin: "#7c3aed",
  land: "#d97706",
  unknown: "#6b7280",
};

/** Step 1 map: K-water plant pins, saved candidates, and click-to-pick. */
export default function SiteMap({
  plants,
  candidates,
  selectedCandidateId,
  picked,
  onPlant,
  onCandidate,
  onPoint,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  // Latest callbacks without rebuilding the map on every render.
  const handlers = useRef({ onPlant, onCandidate, onPoint });
  handlers.current = { onPlant, onCandidate, onPoint };

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { zoomControl: true, attributionControl: true }).setView(
      [36.5, 127.6],
      7,
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) =>
      handlers.current.onPoint({ latitude: e.latlng.lat, longitude: e.latlng.lng }),
    );
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    for (const p of plants) {
      const marker = L.circleMarker([p.latitude, p.longitude], {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: PLANT_COLOR[p.type] || PLANT_COLOR.unknown,
        fillOpacity: 0.95,
      });
      marker.bindTooltip(
        `<b>${p.name}</b><br>${p.type_label} · ${num(p.capacity_kw, 0)} kW` +
          (p.specific_yield ? `<br>실적 ${num(p.specific_yield, 0)} kWh/kWp·년` : ""),
        { direction: "top", offset: [0, -6] },
      );
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        handlers.current.onPlant(p);
      });
      marker.addTo(group);
    }
    for (const c of candidates) {
      const selected = c.id === selectedCandidateId;
      const marker = L.marker([c.latitude, c.longitude], {
        icon: L.divIcon({
          className: "pick-pin" + (selected ? " selected" : ""),
          html: "<span></span>",
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
        zIndexOffset: selected ? 1000 : 500,
      });
      marker.bindTooltip(`<b>${c.name}</b><br>저장된 후보지`, { direction: "top", offset: [0, -20] });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        handlers.current.onCandidate(c.id);
      });
      marker.addTo(group);
    }
    if (picked) {
      L.marker([picked.latitude, picked.longitude], {
        icon: L.divIcon({
          className: "pick-pin picked",
          html: "<span></span>",
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
        zIndexOffset: 2000,
      }).addTo(group);
    }
  }, [plants, candidates, selectedCandidateId, picked]);

  // Center on the selected candidate when it changes.
  useEffect(() => {
    const c = candidates.find((v) => v.id === selectedCandidateId);
    if (c && map.current) map.current.setView([c.latitude, c.longitude], Math.max(map.current.getZoom(), 10));
  }, [selectedCandidateId]);

  return (
    <div className="site-map-wrap">
      <div ref={box} className="site-map" />
      <div className="site-legend">
        <span><i style={{ background: PLANT_COLOR.floating }} />K-water 수상</span>
        <span><i style={{ background: PLANT_COLOR.plant }} />정수장</span>
        <span><i style={{ background: PLANT_COLOR.unknown }} />기타 시설</span>
        <span><i className="pin" />저장된 후보지</span>
      </div>
    </div>
  );
}
