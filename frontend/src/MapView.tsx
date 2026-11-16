import { useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  Candidate,
  Design,
  FindKind,
  Polygon,
  Result,
  Run,
  WaterBody,
  WaterSearch,
  TerrainMode,
  KmaStation,
} from "./types";
import { hasGeometry } from "./types";
import MapSearch from "./MapSearch";
import type { SearchLocation } from "./MapSearch";
import { api, num } from "./api";
import {
  buildDistribution,
  candidateBounds,
  getMetricLegend,
  gradeInfo,
  metricDefinitions,
  rankCandidates,
  siteTypeLabels,
  siteTypeOf,
} from "./mapData";
import type { MapMetric } from "./mapData";
type Mode = "view" | "polygon" | "exclusion" | "grid" | "edit" | "position" | "add";
type Basemap = "street" | "satellite" | "none";
type Props = {
  terrainMode?: TerrainMode;
  /** Sites without a boundary (existing plants) are shown as pins only. */
  candidate: Candidate | null;
  result: Result | null;
  candidates: Candidate[];
  designs: Design[];
  runs: Run[];
  selectedDesignId?: string;
  onSelectCandidate: (id: string) => void;
  onAddCandidate: (position: { latitude: number; longitude: number }) => void;
  onUpdate: (data: Partial<Candidate>) => Promise<void>;
  onAnalyzeAll?: () => void;
  onAddSite?: (site: WaterBody, kind: FindKind) => void;
  onAnalyzeSite?: (site: WaterBody, kind: FindKind) => Promise<void>;
  onAnalyzeCandidate?: (id: string) => Promise<void>;
  analysisBusy?: boolean;
};
/** One entry per searchable layer; max matches the server's per-request limit. */
const FIND: Record<
  FindKind,
  {
    label: string;
    noun: string;
    button: string;
    title: string;
    path: string;
    max: { width: number; height: number };
    /** Most map tiles one search asks for; wider views search the tiles nearest the centre. */
    tiles: number;
    stroke: string;
    active: string;
    fill: string;
    add: string;
    note: string;
  }
> = {
  water: {
    label: "수상",
    noun: "수면",
    button: "이 지역 수면 찾기",
    title: "지금 보이는 지도 범위의 저수지·호수·연못(1 ha 이상)을 찾습니다",
    path: "/water-bodies?",
    max: { width: 0.8, height: 0.6 },
    tiles: 6,
    stroke: "#0369a1",
    active: "#0c4a6e",
    fill: "#38bdf8",
    add: "이 수면을 후보지로 추가",
    note: "점선 사각형 안의 1 ha 이상 저수지·호수·연못입니다.",
  },
  land: {
    label: "지상",
    noun: "지상 부지",
    button: "이 지역 지상 부지 찾기",
    title:
      "지금 보이는 지도 범위의 유휴 부지·주차장·매립지·염전·초지(2,000 m² 이상)를 찾습니다",
    path: "/site-candidates?kind=land&",
    max: { width: 0.3, height: 0.2 },
    tiles: 4,
    stroke: "#a16207",
    active: "#713f12",
    fill: "#facc15",
    add: "이 부지를 후보지로 추가",
    note: "점선 사각형 안의 2,000 m² 이상 유휴 부지·주차장·매립지·염전·초지입니다. 농지·임야는 찾지 않으며, 지목·용도지역·경사·소유는 확인되지 않았습니다.",
  },
  building: {
    label: "건축물",
    noun: "건축물",
    button: "이 지역 건축물 찾기",
    title: "지금 보이는 지도 범위의 면적 30 m² 이상 개별 건축물을 찾습니다",
    path: "/site-candidates?kind=building&",
    max: { width: 0.1, height: 0.08 },
    tiles: 4,
    stroke: "#7e22ce",
    active: "#581c87",
    fill: "#c084fc",
    add: "이 건축물을 후보지로 추가",
    note: "OpenStreetMap에 등록된 30 m² 이상 건축물입니다. 지붕 구조·허용 하중·소유는 확인되지 않았습니다.",
  },
};
const KINDS = Object.keys(FIND) as FindKind[];
const candidateKind = (c: Candidate): FindKind =>
  ["rooftop", "plant"].includes(siteTypeOf(c)) ? "building" : siteTypeOf(c) === "land" ? "land" : "water";
/** The site-type chip each searched layer shares with the ranking list. */
const MARK: Record<FindKind, { chip: string }> = {
  water: { chip: "floating" },
  land: { chip: "land" },
  building: { chip: "rooftop" },
};
/** Line icons (Lucide paths, ISC) so a type reads from a distance, not just by colour. */
const ICON_PATHS: Record<FindKind, string[]> = {
  water: [
    "M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
    "M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
    "M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1",
  ],
  land: [
    "m12 8 6-3-6-3v10",
    "m8 11.99-5.5 3.14a1 1 0 0 0 0 1.74l8.5 4.86a2 2 0 0 0 2 0l8.5-4.86a1 1 0 0 0 0-1.74L16 12",
    "m6.49 12.85 11.02 6.3",
    "M17.51 12.85 6.5 19.15",
  ],
  building: [
    "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z",
    "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2",
    "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2",
    "M10 6h4",
    "M10 10h4",
    "M10 14h4",
    "M10 18h4",
  ],
};
function typeIcon(kind: FindKind) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[kind]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function TypeIcon({ kind }: { kind: FindKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="type-icon">
      {ICON_PATHS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
type Bbox = [number, number, number, number];
/** Everything found for one layer so far; each search adds its tiles instead of replacing. */
type Found = {
  results: WaterBody[];
  boxes: Bbox[];
  /** Smaller sites the server left out (it returns the largest per tile). */
  omitted: number;
  /** Tiles of the latest search left out because the view was too wide. */
  skipped: number;
  attribution: string;
  warning: string | null;
};
type Picked = { site: WaterBody; kind: FindKind };
const inBox = (lng: number, lat: number, [w, s, e, n]: Bbox) =>
  lng >= w && lng <= e && lat >= s && lat <= n;
/** Split the view into tiles the server accepts, nearest the centre first. */
function tilesFor(kind: FindKind, b: L.LatLngBounds) {
  const { max, tiles: limit } = FIND[kind];
  const west = Math.max(-180, b.getWest()), east = Math.min(180, b.getEast()),
    south = Math.max(-90, b.getSouth()), north = Math.min(90, b.getNorth());
  const nx = Math.max(1, Math.ceil((east - west) / max.width - 1e-9)),
    ny = Math.max(1, Math.ceil((north - south) / max.height - 1e-9));
  const tw = (east - west) / nx, th = (north - south) / ny,
    cx = (west + east) / 2, cy = (south + north) / 2;
  const all: Bbox[] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      // Rounded inward so a tile never exceeds the server's size limit.
      all.push([
        Math.ceil((west + i * tw) * 10000) / 10000,
        Math.ceil((south + j * th) * 10000) / 10000,
        Math.floor((west + (i + 1) * tw) * 10000) / 10000,
        Math.floor((south + (j + 1) * th) * 10000) / 10000,
      ]);
  const dist = ([w, s, e, n]: Bbox) => Math.hypot((w + e) / 2 - cx, (s + n) / 2 - cy);
  all.sort((a, c) => dist(a) - dist(c));
  return { tiles: all.slice(0, limit), skipped: Math.max(0, all.length - limit) };
}
function merge(prev: Found | undefined, add: WaterSearch, box: Bbox, skipped: number): Found {
  const ids = new Set(prev?.results.map((r) => r.id));
  return {
    results: [...(prev?.results ?? []), ...add.results.filter((r) => !ids.has(r.id))]
      .sort((a, c) => c.area_m2 - a.area_m2),
    boxes: [...(prev?.boxes ?? []), box],
    omitted: (prev?.omitted ?? 0) + Math.max(0, add.total - add.results.length),
    skipped,
    attribution: add.attribution,
    warning: add.warning,
  };
}
function without<T>(record: Partial<Record<FindKind, T>>, kinds: FindKind[]) {
  const next = { ...record };
  for (const kind of kinds) delete next[kind];
  return next;
}
const hectares = (m2: number) => num(m2 / 10000, m2 < 100000 ? 1 : 0);
const areaText = (m2: number) =>
  m2 < 10000 ? `${num(m2, 0)} m²` : `${hectares(m2)} ha`;
const waterName = (w: WaterBody) => w.name || `이름 없는 ${w.kind}`;
function inRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
const onWater = (c: Candidate, waters: WaterBody[]) =>
  waters.some(
    (w) =>
      inRing(c.longitude, c.latitude, w.geometry.coordinates[0]) &&
      !w.geometry.coordinates
        .slice(1)
        .some((hole) => inRing(c.longitude, c.latitude, hole)),
  );
const KOREA: [number, number, number, number] = [125.3, 33, 130.9, 38.7];
const toBounds = (
  b: [number, number, number, number],
): L.LatLngBoundsExpression => [
  [b[1], b[0]],
  [b[3], b[2]],
];
const tools: { id: Mode; label: string; name: string }[] = [
  { id: "view", label: "이동", name: "지도 이동" },
  { id: "polygon", label: "경계 그리기", name: "후보 경계 그리기" },
  { id: "exclusion", label: "제외 구역", name: "제외 구역 그리기" },
  { id: "grid", label: "연결점", name: "전력 연결점 지정" },
  { id: "edit", label: "꼭짓점 수정", name: "경계 꼭짓점 수정" },
];
const hints: Record<Exclude<Mode, "view">, string> = {
  position: "후보지 위치를 지도에서 클릭하세요. 좌표와 경계를 함께 이동해 저장합니다.",
  add: "새 후보지 위치를 지도에서 클릭하세요. 설치장소 유형과 좌표를 확인한 뒤 저장합니다.",
  polygon: "지도를 클릭해 후보 경계의 꼭짓점을 3개 이상 찍은 뒤 저장하세요.",
  exclusion: "설치하지 않을 구역의 꼭짓점을 3개 이상 찍은 뒤 저장하세요.",
  grid: "육상 전력 연결점을 지도에서 한 번 클릭하세요.",
  edit: "흰 점을 끌어 경계를 고치세요. 놓는 즉시 저장됩니다.",
};
const el = (tag: string, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
function siteIcon(kind: FindKind, selected: boolean, saved = false) {
  const drop = el("span", "");
  drop.append(typeIcon(kind));
  return L.divIcon({
    className: `find-pin find-pin-${kind}${selected ? " active" : ""}${saved ? " saved-site-pin" : ""}`,
    html: drop, iconSize: [30, 30], iconAnchor: [15, 36],
  });
}
function label(name: string, detail?: string) {
  const node = document.createElement("div"),
    title = document.createElement("strong");
  title.textContent = name;
  node.append(title);
  if (detail) {
    const sub = document.createElement("span");
    sub.textContent = detail;
    node.append(sub);
  }
  return node;
}

export default function MapView({
  candidate,
  result,
  candidates,
  designs,
  runs,
  selectedDesignId,
  onSelectCandidate,
  onAddCandidate,
  onUpdate,
  onAnalyzeAll,
  onAddSite,
  onAnalyzeSite,
  onAnalyzeCandidate,
  analysisBusy = false,
  terrainMode = "floating",
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    tiles = useRef<Record<Exclude<Basemap, "none">, L.TileLayer> | null>(null),
    latest = useRef({ candidate, onUpdate, onSelectCandidate, onAddCandidate });
  latest.current = { candidate, onUpdate, onSelectCandidate, onAddCandidate };
  const [mode, setMode] = useState<Mode>("view"),
    [draft, setDraft] = useState<number[][]>([]),
    [ready, setReady] = useState(false),
    [basemap, setBasemap] = useState<Basemap>("satellite"),
    [tileError, setTileError] = useState(false),
    [busy, setBusy] = useState(false),
    [mapError, setMapError] = useState("");
  const [stations, setStations] = useState<KmaStation[]>([]);
  const [stationError, setStationError] = useState("");
  const [showStations, setShowStations] = useState(false);
  const [metric, setMetric] = useState<MapMetric | "type">("type"),
    [target, setTarget] = useState<SearchLocation | null>(null),
    [center, setCenter] = useState({ latitude: 36.4, longitude: 127.8 });
  // Searched layers stay side by side so water, land and roofs read on one map.
  const [found, setFound] = useState<Partial<Record<FindKind, Found>>>({}),
    [finding, setFinding] = useState<FindKind[]>([]),
    [progress, setProgress] = useState<Partial<Record<FindKind, [number, number]>>>({}),
    [findError, setFindError] = useState<Partial<Record<FindKind, string>>>({}),
    [hidden, setHidden] = useState<FindKind[]>([]),
    [picked, setPicked] = useState<Picked | null>(null),
    [panel, setPanel] = useState<"rank" | "sites">("rank");
  const modeRef = useRef(mode),
    searchRun = useRef(0);
  const [viewport, setViewport] = useState(0),
    [autoFind, setAutoFind] = useState(true),
    [analyzing, setAnalyzing] = useState(false),
    [analysisError, setAnalysisError] = useState("");
  const autoAttempt = useRef("");
  const [inspecting, setInspecting] = useState(false);
  modeRef.current = mode;
  const waterBusy = finding.length > 0,
    water = found.water;
  // After panning away from every searched tile, offer the same search here.
  const searchedKinds = KINDS.filter((k) => found[k]);
  const awayFromSearch =
    !waterBusy &&
    searchedKinds.length > 0 &&
    !searchedKinds.some((k) =>
      found[k]!.boxes.some((box) => inBox(center.longitude, center.latitude, box)),
    );
  const layers = KINDS.map((kind) => {
    const data = found[kind],
      kinds = new Map<string, number>();
    for (const site of data?.results ?? [])
      kinds.set(site.kind, (kinds.get(site.kind) || 0) + 1);
    return {
      kind,
      data,
      busy: finding.includes(kind),
      error: findError[kind],
      shown: !!data && !hidden.includes(kind),
      area: (data?.results ?? []).reduce((sum, site) => sum + site.area_m2, 0),
      breakdown: [...kinds].sort((a, b) => b[1] - a[1]),
    };
  });
  const foundTotal = layers.reduce((sum, l) => sum + (l.data?.results.length ?? 0), 0);
  const visibleSites: Picked[] = layers
    .flatMap((l) =>
      l.shown ? l.data!.results.map((site) => ({ site, kind: l.kind })) : [],
    )
    .sort((a, b) => b.site.area_m2 - a.site.area_m2);
  const ranking = useMemo(
    () => rankCandidates(candidates, designs, runs),
    [candidates, designs, runs],
  );
  const selectedDesign = designs.find((design) => design.id === selectedDesignId && design.candidate_id === candidate?.id);
  const selectedRow = useMemo(() => rankCandidates(candidate ? [candidate] : [], selectedDesign ? [selectedDesign] : designs, runs)[0],
    [candidate, selectedDesign, designs, runs]);
  const selectedResult = selectedRow?.stale ? null : selectedRow?.run?.result;
  const distribution = useMemo(
    () =>
      buildDistribution(
        candidates.filter(hasGeometry),
        designs,
        runs,
        metric === "type" ? "none" : metric,
        selectedDesignId,
      ),
    [candidates, designs, runs, metric, selectedDesignId],
  );
  useEffect(() => {
    if (!host.current) return;
    let instance: L.Map | undefined;
    try {
      instance = L.map(host.current, {
        center: [36.4, 127.8],
        zoom: 7,
        minZoom: 3,
        maxZoom: 19,
        zoomControl: false,
        attributionControl: true,
        preferCanvas: true,
        doubleClickZoom: false,
      });
      map.current = instance;
      instance.attributionControl.setPrefix(false);
      // Real water bodies sit beneath candidate boundaries.
      instance.createPane("water").style.zIndex = "350";
      const street = L.tileLayer(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
          maxZoom: 19,
          updateWhenIdle: true,
          keepBuffer: 1,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        },
      );
      const satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
          maxZoom: 19,
          updateWhenIdle: true,
          keepBuffer: 1,
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        },
      );
      for (const layer of [street, satellite])
        layer.on("tileerror", () => setTileError(true));
      satellite.addTo(instance);
      tiles.current = { street, satellite };
      instance.on("click", (event: L.LeafletMouseEvent) => {
        const current = latest.current;
        if (modeRef.current === "add") {
          current.onAddCandidate({ latitude: event.latlng.lat, longitude: event.latlng.lng });
          setMode("view");
          return;
        }
        if (!current.candidate) return;
        const point = [event.latlng.lng, event.latlng.lat];
        if (modeRef.current === "position") {
          const dx = point[0] - current.candidate.longitude, dy = point[1] - current.candidate.latitude;
          const shift = (poly: Polygon): Polygon => ({ ...poly, coordinates: poly.coordinates.map((ring) => ring.map(([x, y]) => [x + dx, y + dy])) });
          void current.onUpdate({ latitude: point[1], longitude: point[0], geometry: current.candidate.geometry && shift(current.candidate.geometry),
                                  exclusions: current.candidate.exclusions.map(shift) })
            .then(() => setMode("view")).catch(() => {});
        } else if (modeRef.current === "grid")
          void current
            .onUpdate({ grid_point: point })
            .then(() => setMode("view"))
            .catch(() => {});
        else if (
          modeRef.current === "polygon" ||
          modeRef.current === "exclusion"
        )
          setDraft((previous) => [...previous, point]);
      });
      instance.on("moveend", () => {
        const p = instance!.getCenter();
        setCenter({ latitude: p.lat, longitude: p.lng });
        setViewport((value) => value + 1);
      });
      L.control
        .scale({ imperial: false, position: "bottomleft" })
        .addTo(instance);
      setReady(true);
      const observer =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => instance?.invalidateSize({ pan: false }))
          : null;
      observer?.observe(host.current);
      return () => {
        observer?.disconnect();
        instance?.remove();
        map.current = null;
      };
    } catch {
      instance?.remove();
      map.current = null;
      setMapError(
        "지도를 초기화하지 못했습니다. 페이지를 새로고침해 다시 시도하세요.",
      );
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<{ stations: KmaStation[] }>("/weather/stations").then((data) => {
      if (!Array.isArray(data.stations)) throw new Error("관측소 목록 응답을 확인해 주세요.");
      if (!cancelled) setStations(data.stations);
    }).catch((e: Error) => { if (!cancelled) setStationError(e.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !showStations) return;
    const group = L.layerGroup().addTo(m);
    for (const station of stations) {
      if (station.latitude == null || station.longitude == null) continue;
      const icon = L.divIcon({ className: `weather-station-icon ${station.has_observations ? "available" : ""}`,
                              html: "☀", iconSize: [22, 22], iconAnchor: [11, 11] });
      const marker = L.marker([station.latitude, station.longitude], { icon, title: `기상청 ${station.name} (${station.stn})`, zIndexOffset: -100 });
      marker.bindPopup(label(`기상청 ${station.name} (${station.stn})`,
        `${station.latitude}, ${station.longitude} · ${station.has_observations ? "일자료 연결 가능" : "일자료 미확보"}`));
      marker.addTo(group);
    }
    return () => { group.remove(); };
  }, [ready, stations, showStations]);
  // Open on the selected site's boundary so the water surface is readable at once.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    setMode("view");
    setDraft([]);
    setTarget(null);
    const bounds = candidate ? candidateBounds([candidate]) : null;
    if (bounds)
      m.fitBounds(toBounds(bounds), {
        padding: [60, 60],
        maxZoom: 16,
        animate: false,
      });
    else if (candidate)
      m.setView([candidate.latitude, candidate.longitude], 14, {
        animate: false,
      });
    else
      m.fitBounds(toBounds(candidateBounds(candidates) || KOREA), {
        padding: [40, 40],
        maxZoom: 13,
        animate: false,
      });
  }, [candidate?.id, candidate?.latitude, candidate?.longitude, ready]);
  useEffect(() => {
    const m = map.current,
      t = tiles.current;
    if (!m || !t || !ready) return;
    for (const [key, layer] of Object.entries(t)) {
      if (key === basemap) {
        if (!m.hasLayer(layer)) layer.addTo(m);
      } else if (m.hasLayer(layer)) m.removeLayer(layer);
    }
  }, [basemap, ready]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const group = L.layerGroup().addTo(m);
    for (const c of candidates) {
      const kind = candidateKind(c);
      if (hidden.includes(kind)) continue;
      const row = ranking.find((entry) => entry.candidate.id === c.id),
        feature = distribution.features.find((entry) => entry.properties.id === c.id),
        selected = c.id === candidate?.id,
        look = FIND[kind],
        color = metric === "type" ? look.fill : metric === "grade"
          ? gradeInfo[row?.stale ? "pending" : row?.grade ?? "pending"].color
          : feature?.properties.color ?? "#94a3b8";
      const select = () => {
        if (modeRef.current !== "view") return;
        setPicked(null);
        setInspecting(true);
        setPanel("rank");
        setAnalysisError("");
        latest.current.onSelectCandidate(c.id);
      };
      const tip = label(c.name, `${siteTypeLabels[siteTypeOf(c)]} · ${row?.stale ? "재분석 필요" : row?.run?.result ? "분석 결과 보기" : "선택하여 분석"}`);
      if (c.geometry)
        L.geoJSON(c.geometry, {
          style: { color: selected ? "#fff" : metric === "type" ? look.stroke : color,
            fillColor: color, fillOpacity: selected ? 0.5 : 0.32,
            weight: selected ? 3 : 1.5, dashArray: row?.stale ? "5 4" : undefined },
          interactive: mode === "view",
          bubblingMouseEvents: false,
        }).bindTooltip(tip, { sticky: true, className: "map-label" })
          .on("click", select).addTo(group);
      L.marker([c.latitude, c.longitude], {
        icon: siteIcon(kind, selected, true),
        title: `${siteTypeLabels[siteTypeOf(c)]}: ${c.name}`,
        alt: `${siteTypeLabels[siteTypeOf(c)]} ${c.name} 분석 보기`,
        interactive: mode === "view", keyboard: mode === "view",
        zIndexOffset: selected ? 500 : 100,
      }).bindTooltip(tip, { direction: "top", offset: [0, -32], className: "map-label" })
        .on("click", select).addTo(group);
    }
    return () => { group.remove(); };
  }, [distribution, ranking, candidate?.id, ready, metric, mode, candidates, hidden]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !candidate || hidden.includes(candidateKind(candidate))) return;
    const group = L.layerGroup().addTo(m);
    for (const g of candidate.exclusions)
      L.geoJSON(g, {
        style: {
          color: "#c2410c",
          fillColor: "#f97316",
          fillOpacity: 0.3,
          weight: 1.5,
          dashArray: "4 3",
        },
        interactive: false,
      }).addTo(group);
    if (result?.layout?.modules?.length)
      L.geoJSON(
        {
          type: "FeatureCollection",
          features: result.layout!.modules.map((geometry) => ({
            type: "Feature",
            properties: {},
            geometry,
          })),
        } as GeoJSON.FeatureCollection<GeoJSON.Polygon>,
        {
          style: {
            color: "#1e3a5f",
            fillColor: "#1e3a5f",
            fillOpacity: 0.85,
            weight: 0.3,
          },
          interactive: false,
        },
      ).addTo(group);
    if (candidate.grid_point) {
      L.polyline(
        [
          [candidate.latitude, candidate.longitude],
          [candidate.grid_point[1], candidate.grid_point[0]],
        ],
        { color: "#b45309", weight: 2.5, dashArray: "6 5", interactive: false },
      ).addTo(group);
      L.marker([candidate.grid_point[1], candidate.grid_point[0]], {
        icon: L.divIcon({
          className: "grid-connection-marker",
          html: "<span></span>",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      })
        .bindTooltip("전력 연결점 (접속 가능 여부 미확인)")
        .addTo(group);
    }
    if (draft.length) {
      const points = draft.map((p) => [p[1], p[0]] as L.LatLngTuple);
      L.polyline([...points, ...(draft.length > 2 ? [points[0]] : [])], {
        color: "#d97706",
        weight: 2.5,
        dashArray: "5 3",
        interactive: false,
      }).addTo(group);
      points.forEach((p) =>
        L.circleMarker(p, {
          radius: 4,
          color: "#fff",
          weight: 1.5,
          fillColor: "#d97706",
          fillOpacity: 1,
          interactive: false,
        }).addTo(group),
      );
    }
    if (mode === "edit" && candidate.geometry)
      candidate.geometry.coordinates[0].slice(0, -1).forEach((p, i) => {
        const marker = L.marker([p[1], p[0]], {
          draggable: true,
          icon: L.divIcon({
            className: "boundary-vertex",
            html: "<span></span>",
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
        }).addTo(group);
        marker.on("dragend", () => {
          const current = latest.current.candidate;
          if (!current?.geometry) return;
          const point = marker.getLatLng(),
            ring = current.geometry.coordinates[0].map((v) => [...v]);
          ring[i] = [point.lng, point.lat];
          ring[ring.length - 1] = [...ring[0]];
          void latest.current
            .onUpdate({ geometry: { type: "Polygon", coordinates: [ring] } })
            .catch(() => {});
        });
      });
    return () => {
      group.remove();
    };
  }, [candidate, result, draft, mode, ready, hidden]);
  useEffect(() => {
    if (map.current)
      map.current.getContainer().style.cursor =
        mode === "view" ? "" : "crosshair";
  }, [mode, ready]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const group = L.layerGroup().addTo(m);
    for (const kind of KINDS) {
      const data = found[kind];
      if (!data || hidden.includes(kind)) continue;
      const look = FIND[kind];
      for (const [w, s, e, n] of data.boxes)
        L.rectangle(
          [
            [s, w],
            [n, e],
          ],
          {
            pane: "water",
            color: look.stroke,
            weight: 1,
            opacity: 0.5,
            dashArray: "6 6",
            fill: false,
            interactive: false,
          },
        ).addTo(group);
      for (const site of data.results) {
        if (candidates.some((c) => c.source?.includes(`· ${site.id} ·`) && candidateKind(c) === kind)) continue;
        const active = picked?.kind === kind && picked.site.id === site.id,
          pick = () => {
            if (modeRef.current !== "view") return;
            const saved = candidates.find((c) => c.source?.includes(`· ${site.id} ·`) && candidateKind(c) === kind);
            setAnalysisError("");
            if (saved) {
              setPicked(null); setInspecting(true); setPanel("rank");
              latest.current.onSelectCandidate(saved.id);
            } else { setPicked({ site, kind }); setInspecting(false); }
          },
          tip = label(
            waterName(site),
            `${look.label} · ${site.kind} · ${areaText(site.area_m2)}`,
          );
        L.geoJSON(site.geometry, {
          pane: "water",
          style: {
            color: active ? look.active : look.stroke,
            weight: active ? 3 : 1.5,
            fillColor: look.fill,
            fillOpacity: active ? 0.6 : 0.4,
          },
          interactive: mode === "view",
        })
          .bindTooltip(tip, { sticky: true, className: "map-label" })
          .on("click", pick)
          .addTo(group);
        // A type pin keeps small roofs and lots findable when zoomed out.
        L.marker([site.latitude, site.longitude], {
          icon: siteIcon(kind, active),
          title: `${look.label}: ${waterName(site)}`,
          interactive: mode === "view",
          keyboard: mode === "view",
          // Above the searched outlines, below candidate pins; the picked one on top.
          zIndexOffset: active ? 400 : -200,
        })
          .bindTooltip(tip, {
            direction: "top",
            offset: [0, -40],
            className: "map-label",
          })
          .on("click", pick)
          .addTo(group);
      }
    }
    return () => {
      group.remove();
    };
  }, [found, hidden, picked, mode, ready, candidates]);
  async function findSites(kinds: FindKind[], automatic = false) {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds(),
      run = ++searchRun.current;
    setFinding(kinds);
    setFindError((previous) => without(previous, kinds));
    if (!automatic) setHidden((previous) => previous.filter((k) => !kinds.includes(k)));
    if (!automatic) setPanel("sites");
    // Results add up, so searching another region keeps what was already found.
    await Promise.all(
      kinds.map(async (kind) => {
        const { tiles, skipped } = tilesFor(kind, b);
        let failed = 0,
          message = "";
        for (const [index, box] of tiles.entries()) {
          if (searchRun.current !== run) break;
          setProgress((previous) => ({ ...previous, [kind]: [index, tiles.length] }));
          try {
            const result = await api<WaterSearch>(
              `${FIND[kind].path}west=${box[0]}&south=${box[1]}&east=${box[2]}&north=${box[3]}`,
            );
            if (searchRun.current !== run) return;
            setFound((previous) => ({
              ...previous,
              [kind]: merge(previous[kind], result, box, skipped),
            }));
          } catch (cause) {
            failed += 1;
            message =
              cause instanceof Error
                ? cause.message
                : `${FIND[kind].noun}을(를) 찾지 못했습니다.`;
          }
        }
        if (searchRun.current !== run) return;
        if (failed)
          setFindError((previous) => ({
            ...previous,
            [kind]:
              failed === tiles.length
                ? message
                : `${tiles.length}칸 중 ${failed}칸을 받지 못했습니다. ${message}`,
          }));
        setFinding((previous) => previous.filter((k) => k !== kind));
      }),
    );
  }
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !autoFind || waterBusy || mode !== "view" || m.getZoom() < 15) return;
    const b = m.getBounds();
    const kinds = KINDS.filter((kind) => !hidden.includes(kind) &&
      !found[kind]?.boxes.some((box) => inBox(b.getWest(), b.getSouth(), box) && inBox(b.getEast(), b.getNorth(), box)));
    if (!kinds.length) return;
    const key = `${kinds.join(",")}:${b.toBBoxString()}`;
    if (autoAttempt.current === key) return;
    const timer = setTimeout(() => {
      autoAttempt.current = key;
      void findSites(kinds, true);
    }, 700);
    return () => clearTimeout(timer);
  }, [ready, viewport, autoFind, waterBusy, mode, hidden]);
  useEffect(() => () => { searchRun.current += 1; }, []);
  async function analyzePicked() {
    if (!picked || !onAnalyzeSite || analyzing || analysisBusy) return;
    setAnalyzing(true); setAnalysisError("");
    try {
      await onAnalyzeSite(picked.site, picked.kind);
      setPicked(null); setInspecting(true); setPanel("rank");
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "분석을 시작하지 못했습니다.");
    } finally { setAnalyzing(false); }
  }
  function stopFinding() {
    searchRun.current += 1;
    setAutoFind(false);
    setFinding([]);
  }
  function clearFound() {
    stopFinding();
    setFound({});
    setFindError({});
    setHidden([]);
    setPicked(null);
    setPanel("rank");
  }
  function toggleLayer(kind: FindKind) {
    setHidden((previous) =>
      previous.includes(kind)
        ? previous.filter((k) => k !== kind)
        : [...previous, kind],
    );
    setPicked((p) => (p?.kind === kind ? null : p));
  }
  function showSite(item: Picked) {
    setPicked(item);
    setInspecting(false);
    setAnalysisError("");
    const ring = item.site.geometry.coordinates[0];
    map.current?.flyToBounds(
      [
        [Math.min(...ring.map((p) => p[1])), Math.min(...ring.map((p) => p[0]))],
        [Math.max(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0]))],
      ],
      { padding: [50, 50], maxZoom: 16, duration: 0.7 },
    );
  }
  function navigate(location: SearchLocation) {
    const m = map.current;
    if (!m) return;
    setTarget(location);
    setMode("view");
    setDraft([]);
    m.flyToBounds(toBounds(location.bbox), {
      padding: [40, 40],
      maxZoom: location.kind === "place" ? 16 : 13,
      duration: 0.8,
    });
  }
  useEffect(() => {
    if (!target || !map.current || !ready) return;
    const marker = L.circleMarker([target.latitude, target.longitude], {
      radius: 6,
      color: "#1d4ed8",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 3,
    })
      .bindTooltip(label(target.label, "검색한 위치"), {
        direction: "top",
        className: "map-label",
      })
      .addTo(map.current);
    return () => {
      marker.remove();
    };
  }, [target, ready]);
  async function complete() {
    if (!candidate || draft.length < 3) return;
    setBusy(true);
    try {
      const geometry: Polygon = {
        type: "Polygon",
        coordinates: [[...draft, draft[0]]],
      };
      await onUpdate(
        mode === "exclusion"
          ? { exclusions: [...candidate.exclusions, geometry] }
          : {
              geometry,
              latitude: draft.reduce((sum, p) => sum + p[1], 0) / draft.length,
              longitude: draft.reduce((sum, p) => sum + p[0], 0) / draft.length,
            },
      );
      setMode("view");
      setDraft([]);
    } catch {
      /* Workspace displays API validation errors. */
    } finally {
      setBusy(false);
    }
  }
  function showAll() {
    map.current?.flyToBounds(toBounds(candidateBounds(candidates) || KOREA), {
      padding: [65, 65],
      maxZoom: 13,
      duration: 0.7,
    });
    setTarget(null);
  }
  function focus() {
    if (candidate)
      map.current?.flyToBounds(toBounds(candidateBounds([candidate])!), {
        padding: [60, 60],
        maxZoom: 17,
        duration: 0.7,
      });
    setTarget(null);
  }
  const drawing = mode === "polygon" || mode === "exclusion";
  return (
    <div className="map">
      <div className="map-toolbar">
        <MapSearch onSelect={navigate} />
        <div className="map-toolbar-actions">
          <div className="find-group" role="group" aria-label="이 지역 후보 찾기">
            <span>이 지역 후보 찾기</span>
            <button
              className="btn find-all"
              aria-label="이 지역 설치 가능 지역 모두 찾기"
              title="지금 보이는 지도 범위에서 수상·지상·건축물 설치 가능 지역을 한꺼번에 찾아 유형별로 표시합니다"
              disabled={!ready || waterBusy}
              onClick={() => void findSites(KINDS)}
            >
              {finding.length > 1 && <span className="spinner" />}
              전체
            </button>
            {KINDS.map((kind) => (
              <button
                key={kind}
                className={`btn find-${kind}`}
                aria-label={FIND[kind].button}
                title={FIND[kind].title}
                disabled={!ready || waterBusy}
                onClick={() => void findSites([kind])}
              >
                {finding.length === 1 && finding[0] === kind && (
                  <span className="spinner" />
                )}
                <TypeIcon kind={kind} /> {FIND[kind].label}
              </button>
            ))}
          </div>
          <button className="btn" aria-pressed={showStations} onClick={() => setShowStations((value) => !value)}>기상청 관측소 {showStations ? "숨기기" : "표시"}</button>
          <button className="btn" aria-pressed={mode === "add"} disabled={!ready} onClick={() => setMode("add")}>지도에서 새 위치 선택</button>
          <button className="btn" aria-pressed={mode === "position"} disabled={!ready || !candidate} onClick={() => setMode("position")}>후보지 위치 지정</button>
          <button
            className="btn"
            onClick={focus}
            disabled={!ready || !candidate}
          >
            선택 후보지
          </button>
          <button className="btn" onClick={showAll} disabled={!ready}>
            전체 보기
          </button>
          <button
            className="btn"
            aria-label="현재 지도 중심에 후보지 추가"
            title="지금 보고 있는 지도의 가운데에 새 후보지를 만듭니다"
            disabled={!ready}
            onClick={() => onAddCandidate(center)}
          >
            후보지 추가
          </button>
        </div>
      </div>
      {candidate && (
        <div className="map-modes" role="toolbar" aria-label="지도 편집 도구">
          {tools.map((t) => (
            <button
              key={t.id}
              aria-label={t.name}
              aria-pressed={mode === t.id}
              disabled={!ready || (t.id === "edit" && !candidate.geometry)}
              className={mode === t.id ? "active" : ""}
              onClick={() => {
                setMode(t.id);
                setDraft([]);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {showStations && stationError && <p className="inline-warning">관측소 지도 표시 실패: {stationError}</p>}
      <div className="map-body">
      <div className="map-canvas">
        <div className="map-host" ref={host} aria-label={terrainMode === "floating" ? "수면 후보지 지도" : "육상·건축물 후보지 지도"} />
        <div className="map-type-controls" role="group" aria-label="지도 설치 유형">
          <strong>설치 대상</strong>
          {(["building", "land", "water"] as FindKind[]).map((kind) => (
            <button key={kind} className={`type-filter find-swatch find-pin-${kind}`}
              aria-pressed={!hidden.includes(kind)} aria-label={`${FIND[kind].label} 지도 표시`}
              onClick={() => toggleLayer(kind)}><TypeIcon kind={kind} />{FIND[kind].label}</button>
          ))}
          <label><input type="checkbox" checked={autoFind} onChange={(event) => { autoAttempt.current = ""; setAutoFind(event.target.checked); }} />주변 자동 표시</label>
        </div>
        {!waterBusy && !picked && mode === "view" && (
          <div className="map-instruction">건축물·부지·수면의 영역 또는 아이콘을 클릭해 분석하세요.
            {autoFind && (map.current?.getZoom() ?? 0) < 15 && <span>확대하면 주변 대상이 자동으로 표시됩니다.</span>}
          </div>
        )}
        {mode === "view" && (awayFromSearch || waterBusy) && (
          <div className="map-research">
            {waterBusy ? (
              <>
                <span className="spinner" />
                설치 가능 지역 찾는 중
                <button className="btn" onClick={stopFinding}>
                  중지
                </button>
              </>
            ) : (
              <button
                className="btn primary"
                onClick={() => void findSites(searchedKinds)}
              >
                이 위치에서 다시 찾기 (
                {searchedKinds.map((k) => FIND[k].label).join("·")})
              </button>
            )}
          </div>
        )}
        {mode !== "view" && (
          <div className="map-hint">
            <span>{hints[mode]}</span>
            {drawing && (
              <>
                <button
                  className="btn"
                  disabled={!draft.length}
                  onClick={() => setDraft((d) => d.slice(0, -1))}
                >
                  한 점 취소
                </button>
                <button
                  className="btn primary"
                  disabled={draft.length < 3 || busy}
                  onClick={() => void complete()}
                >
                  경계 저장 ({draft.length})
                </button>
              </>
            )}
            <button
              className="btn"
              onClick={() => {
                setMode("view");
                setDraft([]);
              }}
            >
              {mode === "edit" ? "완료" : "취소"}
            </button>
          </div>
        )}
        {picked && mode === "view" && (
          <div
            className="water-card"
            style={{ borderColor: FIND[picked.kind].stroke }}
          >
            <div>
              <strong>
                <i className={`type-chip type-${MARK[picked.kind].chip}`}>
                  {FIND[picked.kind].label}
                </i>
                {waterName(picked.site)}
              </strong>
              <span>
                {picked.site.kind} · {areaText(picked.site.area_m2)}
              </span>
            </div>
            {onAnalyzeSite && <button className="btn primary" disabled={analyzing || analysisBusy} onClick={() => void analyzePicked()}>
              {analyzing ? "분석 준비 중…" : "이 대상 분석하기"}
            </button>}
            {onAddSite && (
              <button
                className="btn"
                disabled={analyzing || analysisBusy}
                onClick={() => {
                  onAddSite(picked.site, picked.kind);
                  setPicked(null);
                }}
              >
                {FIND[picked.kind].add}
              </button>
            )}
            <button
              className="close"
              aria-label="선택 해제"
              onClick={() => setPicked(null)}
            >
              ×
            </button>
          </div>
        )}
        <div className="map-zoom">
          <button
            aria-label="지도 확대"
            disabled={!ready}
            onClick={() => map.current?.zoomIn()}
          >
            +
          </button>
          <button
            aria-label="지도 축소"
            disabled={!ready}
            onClick={() => map.current?.zoomOut()}
          >
            −
          </button>
        </div>
        <div className="map-basemap" role="group" aria-label="배경지도">
          {(
            [
              ["street", "일반"],
              ["satellite", "위성"],
              ["none", "없음"],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              aria-pressed={basemap === key}
              className={basemap === key ? "active" : ""}
              disabled={!ready}
              onClick={() => {
                setBasemap(key);
                setTileError(false);
              }}
            >
              {text}
            </button>
          ))}
        </div>
        {tileError && basemap !== "none" && (
          <div className="map-notice">
            배경지도를 불러오지 못했습니다. 경계 편집은 계속할 수 있습니다.
            <button
              onClick={() => {
                setTileError(false);
                tiles.current?.[basemap].redraw();
              }}
            >
              다시 시도
            </button>
          </div>
        )}
        {mapError && (
          <div className="map-init-error" role="alert">
            {mapError}
          </div>
        )}
      </div>
      <aside className="rank-panel" aria-label="대상별 태양광 분석">
        {analysisError && <p className="inline-warning" role="alert">{analysisError}</p>}
        {panel === "rank" && layers.filter((layer) => layer.error && !hidden.includes(layer.kind)).map((layer) =>
          <p key={layer.kind} className="inline-warning">{FIND[layer.kind].label} 지도 자료: {layer.error}</p>)}
        {picked ? <section className="map-site-detail" aria-label="선택한 지도 대상">
          <span className={`detail-type find-swatch find-pin-${picked.kind}`}><TypeIcon kind={picked.kind} />{FIND[picked.kind].label}</span>
          <h4>{waterName(picked.site)}</h4><p>{picked.site.kind} · {areaText(picked.site.area_m2)}</p>
          <p className="hint">이 대상의 지도 경계를 기준으로 설치 용량·발전량·사업성을 분석합니다.</p>
          {onAnalyzeSite && <button className="btn primary block" disabled={analyzing || analysisBusy} onClick={() => void analyzePicked()}>{analyzing ? "분석 준비 중…" : "이 대상 분석하기"}</button>}
          <p className="hint">{FIND[picked.kind].note}</p>
        </section> : inspecting && candidate ? <section className="map-site-detail" aria-label="선택한 대상 분석">
          <span className={`detail-type find-swatch find-pin-${candidateKind(candidate)}`}><TypeIcon kind={candidateKind(candidate)} />{siteTypeLabels[siteTypeOf(candidate)]}</span>
          <h4>{candidate.name}</h4>
          {selectedResult ? <dl className="map-analysis-values">
            <div><dt>설치 용량</dt><dd>{num(selectedResult.capacity_dc_kw, 1)} kW</dd></div>
            <div><dt>연간 발전량</dt><dd>{num(selectedResult.annual_kwh / 1000, 1)} MWh</dd></div>
            <div><dt>B/C</dt><dd>{num(selectedResult.economics.bc, 2)}</dd></div>
            <div><dt>순현재가치</dt><dd>{num(selectedResult.economics.npv / 100000000, 2)} 억 원</dd></div>
          </dl> : <p className="hint">{selectedRow?.stale ? "조건이 변경되었습니다. 다시 분석해 주세요." : "아직 분석 결과가 없습니다."}</p>}
          {onAnalyzeCandidate && <button className="btn primary block" disabled={analysisBusy || analyzing} onClick={async () => {
            setAnalyzing(true); setAnalysisError("");
            try { await onAnalyzeCandidate(candidate.id); }
            catch (error) { setAnalysisError(error instanceof Error ? error.message : "분석을 시작하지 못했습니다."); }
            finally { setAnalyzing(false); }
          }}>{analysisBusy || analyzing ? "분석 중…" : selectedResult ? "다시 분석" : "이 대상 분석하기"}</button>}
          <p className="hint">{selectedRow?.design?.name} · 입력된 설계·기상 조건에 따른 사전 검토 결과입니다.</p>
        </section> : <div className="map-selection-help"><h4>대상을 선택하세요</h4><p>지도 위 건축물·지상·수상 아이콘이나 색칠된 영역을 클릭하면 개별 분석을 확인할 수 있습니다.</p><p className="hint">OpenStreetMap에 등록된 대상만 표시됩니다. 확대하면 주변 경계를 자동으로 불러옵니다.</p></div>}
        {(
          <div className="panel-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={panel === "rank"}
              className={panel === "rank" ? "active" : ""}
              onClick={() => setPanel("rank")}
            >
              저장한 대상
            </button>
            <button
              role="tab"
              aria-selected={panel === "sites"}
              className={panel === "sites" ? "active" : ""}
              onClick={() => setPanel("sites")}
            >
              설치 가능 지역
              {layers.some((l) => l.data) ? ` ${foundTotal}` : ""}
            </button>
          </div>
        )}
        {panel === "sites" ? (
          <div className="water-list">
            <ul className="layer-list" aria-label="설치 유형별 표시">
              {layers.map((l) => {
                const look = FIND[l.kind],
                  step = progress[l.kind];
                return (
                  <li key={l.kind} style={{ borderLeftColor: look.fill }}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`${look.label} 표시`}
                        checked={!hidden.includes(l.kind)}
                        onChange={() => toggleLayer(l.kind)}
                      />
                      <i className={`find-swatch find-pin-${l.kind}`}>
                        <TypeIcon kind={l.kind} />
                      </i>
                      <b>{look.label}</b>
                      {l.data && (
                        <span>
                          {num(l.data.results.length)}곳
                          {l.data.results.length > 0 &&
                            ` · ${areaText(l.area)}`}
                        </span>
                      )}
                    </label>
                    {l.busy ? (
                      <small>
                        <span className="spinner" /> OpenStreetMap에서 {look.noun}{" "}
                        경계를 받는 중입니다
                        {step && step[1] > 1 ? ` (${step[0] + 1}/${step[1]}칸)` : ""}.
                        처음 찾는 지역은 한 칸에 30초~1분 걸릴 수 있으며, 받은
                        칸부터 지도에 표시합니다.
                      </small>
                    ) : l.error ? (
                      <small className="error">
                        {l.error}{" "}
                        <button
                          className="btn"
                          disabled={waterBusy}
                          onClick={() => void findSites([l.kind])}
                        >
                          다시 찾기
                        </button>
                      </small>
                    ) : !l.data ? (
                      <small>
                        아직 찾지 않았습니다.{" "}
                        <button
                          className="btn"
                          disabled={waterBusy}
                          onClick={() => void findSites([l.kind])}
                        >
                          찾기
                        </button>
                      </small>
                    ) : l.data.results.length ? (
                      <small>
                        {l.breakdown
                          .map(([name, count]) => `${name} ${count}`)
                          .join(" · ")}
                        {l.data.omitted > 0 &&
                          ` · 칸마다 면적이 큰 곳만 받아 작은 곳 일부는 빠졌습니다(확대해 다시 찾으면 보입니다)`}
                        {l.data.skipped > 0 && (
                          <em className="find-skipped">
                            화면이 넓어 가운데 {look.tiles}칸만 찾았습니다(
                            {l.data.skipped}칸 남음). 확대하거나 지도를 옮겨 다시
                            찾으면 결과가 더해집니다.
                          </em>
                        )}
                      </small>
                    ) : (
                      <small>
                        {l.data.warning ||
                          `이 범위에서 ${look.noun}을(를) 찾지 못했습니다.`}
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
            {visibleSites.length > 0 && (
              <>
                <p className="rank-note">
                  핀 아이콘과 색이 설치 유형입니다(물결 수상 · 부지 지상 · 건물
                  건축물). 점선 사각형은 이미 찾은 범위입니다. 지도를 옮겨 다시
                  찾으면 결과가 더해집니다. 클릭하면 지도에서 보여 주고 후보지로
                  추가해 분석할 수 있습니다.
                </p>
                <ol>
                  {visibleSites.map((item) => (
                    <li key={`${item.kind}:${item.site.id}`}>
                      <button
                        className={
                          picked?.kind === item.kind &&
                          picked.site.id === item.site.id
                            ? "active"
                            : ""
                        }
                        style={{ borderLeftColor: FIND[item.kind].fill }}
                        onClick={() => showSite(item)}
                      >
                        <span className="rank-body">
                          <b>
                            <i className={`type-chip type-${MARK[item.kind].chip}`}>
                              {FIND[item.kind].label}
                            </i>
                            {waterName(item.site)}
                          </b>
                          <small>
                            {item.site.kind} · {areaText(item.site.area_m2)}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {layers
              .filter((l) => l.shown && l.data!.results.length)
              .map((l) => (
                <p className="rank-note" key={l.kind}>
                  {FIND[l.kind].note.replace("점선 사각형 안의 ", "")}{" "}
                  {l.data!.attribution}
                </p>
              ))}
            {layers.some((l) => l.data) && (
              <button className="btn block" onClick={clearFound}>
                찾은 결과 모두 지우기
              </button>
            )}
          </div>
        ) : (
          <>
        <div className="rank-head"><h4>저장한 대상</h4><span>{candidates.length}곳</span></div>
        <ol>
          {candidates.filter((c) => !hidden.includes(candidateKind(c))).map((c) => ranking.find((row) => row.candidate.id === c.id)!).map((row) => {
            const e = row.stale ? undefined : row.run?.result?.economics,
              info = gradeInfo[row.stale ? "pending" : row.grade];
            return (
              <li key={row.candidate.id}>
                <button
                  className={
                    row.candidate.id === candidate?.id ? "active" : ""
                  }
                  onClick={() => {
                    setPicked(null); setInspecting(true); setAnalysisError("");
                    latest.current.onSelectCandidate(row.candidate.id);
                    if (row.candidate.id === candidate?.id) focus();
                  }}
                >
                  <span className={`list-type-icon find-swatch find-pin-${candidateKind(row.candidate)}`}><TypeIcon kind={candidateKind(row.candidate)} /></span>
                  <span className="rank-body">
                    <b>
                      <i className={`type-chip type-${siteTypeOf(row.candidate)}`}>
                        {siteTypeLabels[siteTypeOf(row.candidate)]}
                      </i>
                      {row.candidate.name}
                    </b>
                    <small>
                      {e
                        ? `B/C ${num(e.bc, 2)} · NPV ${num(e.npv / 100000000, 1)}억 원`
                        : row.stale
                          ? "조건이 바뀌어 다시 분석해야 합니다"
                          : "아직 분석하지 않았습니다"}
                    </small>
                    {row.design && <small>최적 대안: {row.design.name}</small>}
                    {water &&
                      siteTypeOf(row.candidate) === "floating" &&
                      !onWater(row.candidate, water.results) &&
                      water.boxes.some((box) =>
                        inBox(row.candidate.longitude, row.candidate.latitude, box),
                      ) && (
                        <small className="off-water">
                          지도상 수면 밖에 있습니다
                        </small>
                      )}
                  </span>
                  <span
                    className="grade-badge"
                    style={{ color: info.color, background: info.soft }}
                  >
                    {row.stale ? "재분석" : info.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {onAnalyzeAll && ranking.some((r) => !r.run) && (
          <button className="btn block" onClick={onAnalyzeAll}>
            전체 대안 분석하기
          </button>
        )}
        <p className="rank-note">
          추천 = B/C 1.2 이상·NPV 0 초과. 수상·지상·건축물을 같은 기준으로
          줄 세운 사전 검토용 등급이며 인허가·계통·수심·지형·지붕 구조 조건은
          반영되지 않았습니다.
        </p>
          </>
        )}
      </aside>
      </div>
      <div className="map-legend">
        <label>
          색상 기준
          <select
            aria-label="지도 색상 지표"
            value={metric}
            onChange={(e) => setMetric(e.target.value as MapMetric | "type")}
          >
            <option value="type">설치 대상 유형</option>
            {Object.entries(metricDefinitions).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
                {value.unit ? ` (${value.unit})` : ""}
              </option>
            ))}
          </select>
        </label>
        <ul>
          {(metric === "type" ? KINDS.map((kind) => ({ label: FIND[kind].label, color: FIND[kind].fill })) : getMetricLegend(metric)).map((item) => (
            <li key={item.label}>
              <i style={{ background: item.color }} />
              {item.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
