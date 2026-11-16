import { useEffect, useRef } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Candidate, Plant, WeatherStation } from "./types";
import { num } from "./api";
import { siteTypeLabel } from "./types";
import { typeIconSvg } from "./typeIcons";

/** 저장된 후보지 핀의 설치 유형 (수면 · 지상 부지 · 건축물). */
const pinKind = (siteType: string) =>
  siteType === "building" ? "building" : siteType === "land" || siteType === "plant" ? "land" : "water";

type Point = { latitude: number; longitude: number };

const coordText = (p: Point) => `위도 ${num(p.latitude, 5)} · 경도 ${num(p.longitude, 5)}`;
type Props = {
  plants: Plant[];
  candidates: Candidate[];
  selectedCandidateId: string;
  picked: Point | null;
  stations?: WeatherStation[];
  nearestStation?: WeatherStation | null;
  /** Point the nearest-station line starts from (picked point or selected candidate). */
  focus?: Point | null;
  onPlant: (plant: Plant) => void;
  onCandidate: (id: string) => void;
  onPoint: (point: Point) => void;
};

const PLANT_COLOR: Record<string, string> = {
  floating: "#00B9ED",
  plant: "#005596",
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
  stations = [],
  nearestStation = null,
  focus = null,
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
    for (const st of stations) {
      const near = nearestStation?.stn === st.stn;
      const marker = L.marker([st.latitude, st.longitude], {
        icon: L.divIcon({
          className: "station-icon" + (near ? " nearest" : ""),
          html: "<span></span>",
          iconSize: near ? [18, 18] : [12, 12],
          iconAnchor: near ? [9, 9] : [6, 6],
        }),
        zIndexOffset: near ? 300 : -100,
        keyboard: false,
      });
      marker.bindTooltip(
        `<b>기상청 ${st.name} 관측소 (${st.stn})</b><br>ASOS · 해발 ${num(st.elevation_m, 0)} m<br>${coordText(st)}` +
          (near && nearestStation?.distance_km != null
            ? `<br>선택 위치에서 ${num(nearestStation.distance_km, 1)} km (가장 가까움)`
            : ""),
        { direction: "top", offset: [0, -6] },
      );
      marker.addTo(group);
    }
    if (focus && nearestStation) {
      L.polyline(
        [
          [focus.latitude, focus.longitude],
          [nearestStation.latitude, nearestStation.longitude],
        ],
        { color: "#7c3aed", weight: 2, dashArray: "6 6", interactive: false },
      ).addTo(group);
    }
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
          (p.specific_yield ? `<br>실적 ${num(p.specific_yield, 0)} kWh/kWp·년` : "") +
          `<br>${coordText(p)}`,
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
          className: `pick-pin kind-${pinKind(c.site_type)}` + (selected ? " selected" : ""),
          html: `<span><b>${typeIconSvg(pinKind(c.site_type), 12)}</b></span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
        zIndexOffset: selected ? 1000 : 500,
      });
      marker.bindTooltip(`<b>${c.name}</b><br>저장된 후보지 · ${siteTypeLabel(c.site_type)}<br>${coordText(c)}`, { direction: "top", offset: [0, -20] });
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
  }, [plants, candidates, selectedCandidateId, picked, stations, nearestStation, focus?.latitude, focus?.longitude]);

  // Center on the selected candidate when it changes.
  useEffect(() => {
    const c = candidates.find((v) => v.id === selectedCandidateId);
    if (c && map.current) map.current.setView([c.latitude, c.longitude], Math.max(map.current.getZoom(), 10));
  }, [selectedCandidateId]);

  return (
    <div className="site-map-wrap">
      <div ref={box} className="site-map" />
      {focus && (
        <div className="map-coords" aria-label="선택 위치 좌표">
          {coordText(focus)}
        </div>
      )}
      <div className="site-legend">
        <span><i style={{ background: PLANT_COLOR.floating }} />K-water 수상</span>
        <span><i style={{ background: PLANT_COLOR.plant }} />정수장</span>
        <span><i style={{ background: PLANT_COLOR.unknown }} />기타 시설</span>
        <span><i className="pin kind-water" />수면 후보지</span>
        <span><i className="pin kind-land" />지상 후보지</span>
        <span><i className="pin kind-building" />건축물 후보지</span>
        <span><i className="station" />기상청 관측소</span>
      </div>
    </div>
  );
}
