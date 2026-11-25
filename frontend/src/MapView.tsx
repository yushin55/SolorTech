import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  SiteType,
  Candidate,
  Design,
  Polygon,
  Result,
  Run,
  WaterBody,
  WaterSearch,
  Plant,
  PlantList,
} from "./types";
import MapSearch from "./MapSearch";
import Regulations from "./Regulations";
import SelectedSite from "./SelectedSite";
import FacilityPopup from "./FacilityPopup";
import type { MapFacility } from "./FacilityPopup";
import type { SiteTab } from "./SelectedSite";
import { typeIconSvg } from "./typeIcons";
import type { FindKind } from "./typeIcons";
import type { SearchLocation } from "./MapSearch";
import { api, num } from "./api";
import {
  buildDistribution,
  candidateInputSignature,
  candidateBounds,
  designInputSignature,
  getMetricLegend,
  gradeInfo,
  metricDefinitions,
  mappedCandidate,
  rankCandidates,
} from "./mapData";
import type { MapMetric, SiteRanking } from "./mapData";
type Mode = "view" | "polygon" | "exclusion" | "grid" | "edit";
type Basemap = "street" | "satellite" | "none";
export type ClimateMode = "potential" | "generation" | "regulations";
type Props = {
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
  selection: MapSelection;
  onPick: (selection: MapSelection) => void;
  onContinueSite?: (site: WaterBody, siteType: SiteType, preferredDesignId?: string) => Promise<void>;
  preparingSite?: boolean;
  onPoint?: (position: { latitude: number; longitude: number }) => void;
  pickedPoint?: { latitude: number; longitude: number } | null;
  regulationContainer?: HTMLElement | null;
  onPickPlant?: (plant: Plant) => Promise<void>;
  climateMode?: ClimateMode;
};
// Matches the server's per-request limits (waterbodies.py · sitefinder.py).
// `selected` is the fill of a picked boundary; it contrasts with that layer's own `fill`.
const FIND: Record<FindKind, { stroke: string; active: string; fill: string; selected: string; width: number; height: number; label: string; obj: string; siteType: SiteType; busy: string; note: string; empty: string }> = {
  water: {
    stroke: "#005596", active: "#003a68", fill: "#00b9ed", selected: "#ffffff",
    width: 0.8, height: 0.6, label: "수면", obj: "수면을", siteType: "floating", busy: "저수지·호수 경계",
    note: "수면 경계입니다. 경계를 선택하면 수상 태양광 설계로 검토합니다.", empty: "이 범위에 등록된 수면 경계가 없습니다.",
  },
  land: {
    stroke: "#a16207", active: "#713f12", fill: "#facc15", selected: "#38bdf8",
    width: 0.3, height: 0.2, label: "지상 부지", obj: "지상 부지를", siteType: "land", busy: "유휴 부지·주차장 경계",
    note: "농지·산림 등을 포함한 토지이용·피복 경계입니다. 지적 필지나 설치 허용 여부를 나타내지 않습니다.",
    empty: "이 범위에서 지상 부지를 찾지 못했습니다.",
  },
  building: {
    stroke: "#38bdf8", active: "#facc15", fill: "#7dd3fc", selected: "#7dd3fc",
    width: 0.1, height: 0.08, label: "건축물", obj: "건축물을", siteType: "building", busy: "건축물 외곽",
    note: "지도에 등록된 건축물 외곽입니다. 지붕 구조·하중·소유는 별도 확인합니다.",
    empty: "이 범위에서 건축물을 찾지 못했습니다.",
  },
};
const KINDS: FindKind[] = ["land", "water", "building"];
type FoundLayer = WaterSearch & { bbox: [number, number, number, number] };
export type Picked = WaterBody & { findKind: FindKind };
type RegionPick = { findKind: "region"; latitude: number; longitude: number; identifying?: boolean };
export type MapSelection = Picked | RegionPick | null;
type MapFeature = WaterBody & { feature_type: FindKind };
const asPicked = ({ feature_type, ...body }: MapFeature): Picked => ({ ...body, findKind: feature_type });
const hectares = (m2: number) => num(m2 / 10000, m2 < 100000 ? 1 : 0);
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
function gradeText(row: SiteRanking) {
  if (row.stale) return "재분석 필요";
  const g = gradeInfo[row.grade].label;
  return row.rank ? `${row.rank}순위 · ${g}` : g;
}
/** Built with textContent: candidate names are user input. */
function sitePin(row: SiteRanking, selected: boolean) {
  const pin = el(
    "div",
    `site-pin grade-${row.stale ? "pending" : row.grade}` +
      (row.rank === 1 ? " top" : "") +
      (selected ? " selected" : ""),
  );
  pin.append(
    el("span", "site-pin-grade", gradeText(row)),
    el("strong", "", row.candidate.name),
  );
  const e = row.run?.result?.economics;
  if (e) pin.append(el("span", "site-pin-value", `B/C ${num(e.bc, 2)}`));
  return pin;
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
  selection,
  onPick: setPicked,
  onContinueSite,
  preparingSite = false,
  onPoint,
  pickedPoint,
  regulationContainer,
  onPickPlant,
  climateMode,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    infoPanel = useRef<HTMLElement>(null),
    map = useRef<L.Map | null>(null),
    tiles = useRef<Record<Exclude<Basemap, "none">, L.TileLayer> | null>(null),
    latest = useRef({ candidate, onUpdate, onSelectCandidate, onPoint, preparingSite });
  latest.current = { candidate, onUpdate, onSelectCandidate, onPoint, preparingSite };
  const [mode, setMode] = useState<Mode>("view"),
    [draft, setDraft] = useState<number[][]>([]),
    [ready, setReady] = useState(false),
    [basemap, setBasemap] = useState<Basemap>("satellite"),
    [tileError, setTileError] = useState(false),
    [busy, setBusy] = useState(false),
    [mapError, setMapError] = useState("");
  const [metric, setMetric] = useState<MapMetric>(climateMode ? "none" : "grade"),
    [target, setTarget] = useState<SearchLocation | null>(null),
    [center, setCenter] = useState({ latitude: 36.4, longitude: 127.8 });
  const [found, setFound] = useState<Partial<Record<FindKind, FoundLayer>>>({}),
    [hidden, setHidden] = useState<FindKind[]>([]),
    [waterBusy, setWaterBusy] = useState(false),
    [waterError, setWaterError] = useState("");
  const [viewportHint, setViewportHint] = useState("지도를 확대하면 건축물·지상·수상 경계가 함께 표시됩니다.");
  const [roofLayer, setRoofLayer] = useState<FoundLayer | null>(null);
  const [roofStatus, setRoofStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [selectionError, setSelectionError] = useState("");
  const [plants, setPlants] = useState<Plant[]>([]);
  const [plantError, setPlantError] = useState("");
  const [assets, setAssets] = useState<MapFacility[]>([]);
  const [activeFacility, setActiveFacility] = useState<MapFacility | null>(null);
  const [facilityHidden, setFacilityHidden] = useState<string[]>([]);
  const [overlayOpacity, setOverlayOpacity] = useState(35);
  const [siteTab, setSiteTab] = useState<SiteTab>("overview");
  const [showSavedDetails, setShowSavedDetails] = useState(true);
  const regionPoint = selection?.findKind === "region" ? selection : null;
  const selectionLoading = !!regionPoint?.identifying;
  const picked = selection?.findKind === "region" ? null : selection;
  const activeSiteTab = regionPoint && siteTab === "overview" ? "potential" : siteTab;
  const selectionAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (selectionLoading) return () => selectionAbort.current?.abort();
  }, [selectionLoading]);
  const clickSelection = useRef<(point: { latitude: number; longitude: number }) => void>(() => {});
  clickSelection.current = (point) => { void identifyFeature(point); };
  const searchAbort = useRef<AbortController | null>(null);
  const searchVersion = useRef(0);
  const foundLatest = useRef(found);
  foundLatest.current = found;
  const roofResults = useMemo(() => {
    if (!roofLayer?.results.length) return found.building;
    const osmById = new Map(found.building?.results.map((roof) => [roof.id, roof]));
    return { ...roofLayer, results: roofLayer.results.map((roof) => {
      const osmRoof = osmById.get(roof.id);
      if (!osmRoof) return roof;
      return { ...roof, name: osmRoof.name || roof.name, building_info: roof.building_info ? {
        address: osmRoof.building_info?.address || roof.building_info.address,
        levels: roof.building_info.levels || osmRoof.building_info?.levels || null,
        height: roof.building_info.height || osmRoof.building_info?.height || null,
        roof_shape: roof.building_info.roof_shape || osmRoof.building_info?.roof_shape || null,
      } : osmRoof.building_info };
    }) };
  }, [roofLayer, found.building]);
  const layers = { ...found, building: roofResults };
  const shownKinds = KINDS.filter((kind) => layers[kind] && !hidden.includes(kind));
  const sites: Picked[] = shownKinds
    .flatMap((kind) => layers[kind]!.results.map((site) => ({ ...site, findKind: kind })))
    .sort((a, b) => b.area_m2 - a.area_m2);
  const foundTotal = KINDS.reduce((sum, kind) => sum + (layers[kind]?.total ?? 0), 0);
  const pickedType = picked ? FIND[picked.findKind].siteType : !regionPoint && candidate ? candidate.site_type : "building";
  const selectedSite = picked ? mappedCandidate(candidates, picked.id, pickedType) : !regionPoint ? candidate : null;
  const siteRuns = selectedSite ? runs.filter((run) => designs.some((design) => design.id === run.design_id
    && design.candidate_id === selectedSite.id)) : [];
  const preferredDesign = designs.find((design) => design.id === selectedDesignId && design.candidate_id === selectedSite?.id);
  const selectedRun = siteRuns.filter((run) => run.status === "completed" && run.result
    && (!preferredDesign || run.design_id === preferredDesign.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
  const selectedDesign = preferredDesign || designs.find((design) => design.id === selectedRun?.design_id)
    || designs.find((design) => design.candidate_id === selectedSite?.id);
  const selectionStale = !!(selectedSite && selectedRun && selectedDesign
    && (candidateInputSignature(picked ? { ...selectedSite, geometry: picked.geometry, latitude: picked.latitude, longitude: picked.longitude } : selectedSite)
      !== candidateInputSignature(selectedRun.snapshot.candidate)
      || designInputSignature(selectedDesign) !== designInputSignature(selectedRun.snapshot.design)));
  const modeRef = useRef(mode),
    overview = useRef(true);
  modeRef.current = mode;
  const ranking = useMemo(
    () => rankCandidates(candidates, designs, runs),
    [candidates, designs, runs],
  );
  const distribution = useMemo(
    () =>
      buildDistribution(candidates, designs, runs, metric, selectedDesignId),
    [candidates, designs, runs, metric, selectedDesignId],
  );
  function selectSavedSite(site: Candidate) {
    if (latest.current.preparingSite) return;
    latest.current.onSelectCandidate(site.id);
    selectionAbort.current?.abort();
    setSelectionError("");
    setPicked(null);
    setSiteTab("overview");
    setShowSavedDetails(true);
    setActiveFacility(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<PlantList>("/plants", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPlants(Array.isArray(data.plants) ? data.plants : []); })
      .catch(() => { if (!controller.signal.aborted) setPlantError("K-water 시설 위치를 불러오지 못했습니다."); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!climateMode) return;
    const controller = new AbortController();
    void api<{ assets: { id: string; name: string; latitude: number | null; longitude: number | null; capacity_kw: number | null; site_type_raw: string | null; address: string | null }[] }>("/solartech/assets", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setAssets((data.assets || []).filter((asset) => asset.latitude != null && asset.longitude != null).map((asset) => ({
        id: asset.id, name: asset.name, latitude: asset.latitude!, longitude: asset.longitude!, capacity_kw: asset.capacity_kw,
        address: asset.address, source: "solartech", kind: asset.site_type_raw?.includes("수상") ? "water" : asset.site_type_raw?.match(/건축|옥상|지붕/)
          ? "building" : asset.site_type_raw?.match(/지상|육상/)? "land" : "other",
      }))); })
      .catch(() => { if (!controller.signal.aborted) setPlantError("등록 설비정보의 위치를 불러오지 못했습니다."); });
    return () => controller.abort();
  }, [!!climateMode]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const group = L.layerGroup().addTo(map.current);
    const facilities: MapFacility[] = [...plants.map((plant): MapFacility => ({ ...plant, plant, source: "kwater",
      kind: plant.type === "floating" ? "water" : plant.type === "plant" || plant.type === "basin" ? "building" : "land" })), ...assets];
    for (const facility of facilities) {
      if (facilityHidden.includes(facility.kind) || facilityHidden.includes(facility.source)) continue;
      const { kind } = facility;
      const marker = L.marker([facility.latitude, facility.longitude], {
        icon: L.divIcon({ className: `kwater-facility-icon ${kind}${climateMode ? " climate-facility-pin" : ""}`, html: `<span>${typeIconSvg(kind === "other" ? "building" : kind, 18)}</span>`,
          iconSize: climateMode ? [34, 42] : [30, 30], iconAnchor: climateMode ? [17, 40] : [15, 15] }),
        title: `${facility.source === "kwater" ? "K-water" : "등록 설비"} · ${facility.name}`, bubblingMouseEvents: false,
      }).bindTooltip(label(facility.name, `${facility.source === "kwater" ? "K-water" : "등록 설비"} · ${num(facility.capacity_kw, 0)} kW`)).addTo(group);
      marker.on("click", () => {
        if (modeRef.current !== "view" || latest.current.preparingSite) return;
        setPlantError("");
        if (climateMode) {
          setActiveFacility(facility); setPicked(null);
          map.current?.setView([facility.latitude, facility.longitude], Math.max(map.current.getZoom(), 14), { animate: false });
          return;
        }
        setPicked(null);
        setSiteTab("potential");
        if (facility.plant) void onPickPlant?.(facility.plant).catch((cause) => setPlantError(cause instanceof Error ? cause.message : "시설을 선택하지 못했습니다."));
      });
    }
    return () => { group.remove(); };
  }, [plants, assets, ready, onPickPlant, facilityHidden, !!climateMode]);
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
        // A full-viewport canvas intercepts lower panes even outside its paths.
        // SVG lets the exact roof, land or water polygon receive the click.
        preferCanvas: false,
        doubleClickZoom: false,
      });
      map.current = instance;
      instance.attributionControl.setPrefix(false);
      // Real water bodies sit beneath candidate boundaries.
      instance.createPane("water").style.zIndex = "350";
      instance.createPane("objects-land").style.zIndex = "320";
      instance.createPane("objects-water").style.zIndex = "330";
      // Saved site fills must sit underneath individual building selections.
      instance.createPane("objects-building").style.zIndex = "450";
      instance.createPane("object-selection").style.zIndex = "460";
      instance.createPane("regulations").style.zIndex = "340";
      instance.getPane("regulations")!.style.pointerEvents = "none";
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
        if (modeRef.current === "view") {
          clickSelection.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
          return;
        }
        if (!current.candidate) return;
        const point = [event.latlng.lng, event.latlng.lat];
        if (modeRef.current === "grid")
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
        searchAbort.current?.abort();
        selectionAbort.current?.abort();
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
  // Open on the selected site's boundary so the water surface is readable at once.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    setMode("view");
    setShowSavedDetails(true);
    setDraft([]);
    setTarget(null);
    if (picked && candidate?.source?.includes(` · ${picked.id} · `)) return;
    // First visit: show every site so the ranking reads at a glance.
    const first = overview.current;
    overview.current = false;
    const bounds = candidate ? candidateBounds([candidate]) : null;
    if (first)
      m.setView(candidate ? [candidate.latitude, candidate.longitude] : [37.2635, 127.0288], 16, { animate: false });
    else if (bounds)
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
    if (metric === "grade") {
      for (const row of [...ranking].reverse()) {
        const c = row.candidate,
          info = gradeInfo[row.stale ? "pending" : row.grade],
          selected = c.id === candidate?.id;
        const select = () => {
          if (modeRef.current === "view")
            selectSavedSite(c);
        };
        if (c.geometry) L.geoJSON(c.geometry, {
          style: {
            color: selected ? "#005596" : info.color,
            fillColor: info.color,
            fillOpacity: row.run ? 0.3 : 0.12,
            weight: selected ? 3 : 2,
            dashArray: row.stale ? "5 4" : undefined,
          },
          bubblingMouseEvents: false,
          interactive: mode === "view",
        })
          .on("click", select)
          .addTo(group);
        // The pin sits on the northern edge so it never hides the module layout.
        const b = candidateBounds([c]);
        L.marker(b ? [b[3], (b[0] + b[2]) / 2] : [c.latitude, c.longitude], {
          icon: L.divIcon({
            className: "site-pin-anchor",
            html: sitePin(row, selected),
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: mode === "view",
          keyboard: false,
          zIndexOffset: row.rank === 1 ? 1000 : selected ? 500 : 0,
          riseOnHover: true,
        })
          .on("click", select)
          .addTo(group);
      }
      return () => {
        group.remove();
      };
    }
    for (const f of distribution.features) {
      const p = f.properties,
        selected = p.id === candidate?.id,
        available = p.status === "completed",
        detail =
          metric === "none"
            ? undefined
            : p.status === "stale"
              ? "재분석 필요"
              : p.status === "missing"
                ? "분석 전"
                : p.display_value;
      const select = () => {
        if (modeRef.current !== "view") return;
        const site = candidates.find((item) => item.id === p.id);
        if (site) selectSavedSite(site);
      };
      // The selected site's module layout stays visible; its name is in the page header.
      if (climateMode) {
        const item = candidates.find((entry) => entry.id === p.id);
        if (!item) continue;
        const kind = item.site_type === "floating" || item.site_type === "basin" ? "water" : item.site_type === "building" ? "building" : "land";
        if (item.geometry) L.geoJSON(item.geometry, {
          style: { color: selected ? "#facc15" : FIND[kind].stroke, fillColor: FIND[kind].fill, fillOpacity: overlayOpacity / 100,
            weight: selected ? 2.5 : 1.2 }, interactive: mode === "view", bubblingMouseEvents: false,
        }).on("click", select).addTo(group);
        L.marker([item.latitude, item.longitude], { icon: L.divIcon({ className: `site-pin climate-candidate-pin ${kind}${selected ? " selected" : ""}`,
          html: `<span>${typeIconSvg(kind, 16)}</span>`, iconSize: [30, 38], iconAnchor: [15, 36] }), interactive: mode === "view", bubblingMouseEvents: false })
          .bindTooltip(label(item.name, "저장된 후보지"), { direction: "top" }).on("click", select).addTo(group);
        continue;
      }
      const coversLayout = selected && !!result?.layout?.modules?.length;
      const site =
        metric === "none" || coversLayout
          ? undefined
          : candidates.find((c) => c.id === p.id);
      const polygon = L.geoJSON(f, {
        style: {
          color: selected ? "#005596" : p.color,
          fillColor: p.color,
          fillOpacity: available && metric !== "none" ? 0.35 : 0.12,
          weight: selected ? 3 : 1.5,
          dashArray: p.status === "stale" ? "5 4" : undefined,
        },
        bubblingMouseEvents: false,
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          radius: selected ? 9 : 7, color: "#fff", weight: 2,
          fillColor: p.color, fillOpacity: 1, bubblingMouseEvents: false,
        }),
        interactive: mode === "view",
      })
        .on("click", select)
        .addTo(group);
      if (!site)
        polygon.bindTooltip(label(p.name, detail), {
          permanent: !coversLayout,
          sticky: coversLayout,
          direction: coversLayout ? "top" : "center",
          className: "map-label" + (selected ? " selected" : ""),
        });
      if (site?.geometry)
        L.circleMarker([site.latitude, site.longitude], {
          radius: selected ? 9 : 7,
          color: "#fff",
          weight: 2,
          fillColor: p.color,
          fillOpacity: 1,
          bubblingMouseEvents: false,
          interactive: mode === "view",
        })
          .bindTooltip(label(p.name, detail), {
            permanent: true,
            direction: "top",
            offset: [0, -8],
            className: "map-label" + (selected ? " selected" : ""),
          })
          .on("click", select)
          .addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [
    distribution,
    ranking,
    candidate?.id,
    ready,
    metric,
    mode,
    candidates,
    result,
    !!climateMode,
    overlayOpacity,
  ]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !candidate) return;
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
  }, [candidate, result, draft, mode, ready]);
  useEffect(() => {
    if (map.current)
      map.current.getContainer().style.cursor =
        mode === "view" ? "" : "crosshair";
  }, [mode, ready]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !shownKinds.length) return;
    const group = L.layerGroup().addTo(m);
    for (const kind of shownKinds) {
      const layer = layers[kind]!,
        look = FIND[kind];
      // Smaller outlines sit on top when a building has nested structures.
      for (const body of [...layer.results].sort((a, b) => b.area_m2 - a.area_m2)) {
        const tip = label(waterName(body), `${look.label} · ${body.kind} · ${hectares(body.area_m2)} ha`);
        L.geoJSON(body.geometry, {
          pane: `objects-${kind}`,
          style: {
            color: look.stroke,
            weight: 1.5,
            fillColor: look.fill,
            fillOpacity: overlayOpacity / 100,
            className: `map-object object-${kind}`,
          },
          bubblingMouseEvents: false,
          interactive: mode === "view",
        })
          .bindTooltip(tip, { sticky: true, className: "map-label" })
          .on("click", (event: L.LeafletMouseEvent) => {
            if (modeRef.current !== "view") return;
            if (kind !== "building" && roofStatus === "loading" && !hidden.includes("building")) {
              void identifyFeature({ latitude: event.latlng.lat, longitude: event.latlng.lng });
              return;
            }
            selectSite({ ...body, findKind: kind });
          })
          .addTo(group);
      }
    }
    return () => {
      group.remove();
    };
  }, [found, roofResults, roofStatus, hidden, mode, ready, overlayOpacity]);
  useEffect(() => {
    if (!map.current || !ready || !picked || hidden.includes(picked.findKind)) return;
    // The fill must differ from the layer's own colour: a yellow outline and
    // fill on the yellow land layer (or blue on water) showed no change.
    const highlight = L.layerGroup([
      L.geoJSON(picked.geometry, { pane: "object-selection", interactive: false,
        style: { color: "#ffffff", weight: 7, opacity: .9, fill: false } }),
      L.geoJSON(picked.geometry, { pane: "object-selection", interactive: false,
        style: { color: "#facc15", weight: 3, fillColor: FIND[picked.findKind].selected, fillOpacity: .5,
          className: `object-selected object-selected-${picked.findKind}` } }),
    ]).addTo(map.current);
    return () => { highlight.remove(); };
  }, [picked, hidden, ready]);
  useEffect(() => {
    if (!map.current || !ready || !regionPoint) return;
    const marker = L.circleMarker([regionPoint.latitude, regionPoint.longitude], {
      pane: "object-selection", interactive: false, radius: 7, color: "#facc15", weight: 3, fillColor: "#ffffff", fillOpacity: 1,
    }).addTo(map.current);
    return () => { marker.remove(); };
  }, [ready, regionPoint?.latitude, regionPoint?.longitude]);

  useEffect(() => {
    const control = map.current?.attributionControl;
    if (!control || !roofLayer?.results.length || hidden.includes("building")) return;
    const attribution = '<a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener noreferrer">Overture Maps Foundation</a>';
    control.addAttribution(attribution);
    return () => { control.removeAttribution(attribution); };
  }, [roofLayer, hidden]);
  function selectSite(site: Picked) {
    if (latest.current.preparingSite) return;
    selectionAbort.current?.abort();
    setSelectionError("");
    setSiteTab("overview");
    setPicked(site);
    setActiveFacility(null);
  }
  async function identifyFeature(point: { latitude: number; longitude: number }) {
    if (latest.current.preparingSite) return;
    selectionAbort.current?.abort();
    setActiveFacility(null);
    const area: RegionPick = { findKind: "region", ...point };
    setSelectionError("");
    if ((map.current?.getZoom() ?? 0) < 15 || point.latitude < 33 || point.latitude > 39 || point.longitude < 124 || point.longitude > 132) {
      setPicked(area);
      return;
    }
    const priority: Record<FindKind, number> = { building: 0, water: 1, land: 2 };
    const local = sites.filter((site) => inRing(point.longitude, point.latitude, site.geometry.coordinates[0])
      && !site.geometry.coordinates.slice(1).some((ring) => inRing(point.longitude, point.latitude, ring)))
      .sort((a, b) => priority[a.findKind] - priority[b.findKind] || a.area_m2 - b.area_m2)[0];
    if (local?.findKind === "building" || (local && (roofStatus !== "loading" || hidden.includes("building")))) {
      selectSite(local);
      return;
    }
    const controller = new AbortController();
    selectionAbort.current = controller;
    setPicked({ ...area, identifying: true });
    try {
      const position = `latitude=${point.latitude}&longitude=${point.longitude}`;
      if (!hidden.includes("building") && roofStatus !== "ready") {
        const roof = await api<{ feature: MapFeature | null }>(`/roofprints/identify?${position}`, { signal: controller.signal })
          .catch(() => null);
        if (controller.signal.aborted) return;
        if (roof?.feature?.feature_type === "building") {
          selectSite(asPicked(roof.feature));
          return;
        }
        if (local) { selectSite(local); return; }
      }
      const result = await api<{ feature: MapFeature | null; warning: string | null; attribution: string }>(
        `/map-features/identify?${position}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result.feature) {
        if (result.warning) setSelectionError(result.warning);
        setPicked(area);
        return;
      }
      const selected = asPicked(result.feature);
      if (!KINDS.includes(selected.findKind)) throw new Error("선택한 경계의 유형을 확인하지 못했습니다.");
      const { findKind: kind, ...body } = selected;
      setFound((previous) => {
        const old = previous[kind];
        const results = [...(old?.results || []).filter((row) => row.id !== body.id), body];
        const ring = body.geometry.coordinates[0];
        return { ...previous, [kind]: { results, total: Math.max(old?.total || 0, results.length),
          attribution: result.attribution, warning: null,
          bbox: old?.bbox || [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))] } };
      });
      setHidden((old) => old.filter((value) => value !== kind));
      selectSite(selected);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSelectionError(cause instanceof Error ? cause.message : "선택한 경계 정보를 확인하지 못했습니다.");
        setPicked(area);
      }
    }
  }
  async function loadFeatures() {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds();
    if (b.getEast() - b.getWest() > .08 || b.getNorth() - b.getSouth() > .06) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const version = ++searchVersion.current;
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    setWaterBusy(true);
    setWaterError("");
    setRoofStatus("loading");
    const range = new URLSearchParams({ west: String(bbox[0]), south: String(bbox[1]), east: String(bbox[2]), north: String(bbox[3]) });
    void api<{ results: MapFeature[]; attribution: string }>(`/roofprints?${range}`, { signal: controller.signal })
      .then(({ results, attribution }) => {
        if (!Array.isArray(results) || results.some((row) => row.feature_type !== "building")) throw new Error("Invalid building layer");
        if (controller.signal.aborted) return;
        setRoofLayer({ results: results.map(({ feature_type: _kind, ...body }) => body),
          total: results.length, attribution, bbox, warning: null });
        setRoofStatus("ready");
      }).catch(() => { if (!controller.signal.aborted) setRoofStatus("unavailable"); });
    try {
      const result = await api<Omit<WaterSearch, "results"> & { results: MapFeature[] }>(`/map-features?${range}`, { signal: controller.signal });
      if (controller.signal.aborted || version !== searchVersion.current) return;
      if (!Array.isArray(result.results) || result.results.some((row) => !KINDS.includes(row.feature_type)))
        throw new Error("지도 경계 응답을 확인하지 못했습니다. 다시 불러와 주세요.");
      const next: Partial<Record<FindKind, FoundLayer>> = {};
      for (const kind of KINDS) {
        const results = result.results.filter((row) => row.feature_type === kind).map(({ feature_type: _kind, ...body }) => body);
        next[kind] = { ...result, results, total: results.length, bbox };
      }
      setFound(next);
    } catch (cause) {
      if (!controller.signal.aborted) setWaterError(cause instanceof Error ? cause.message : "지도 경계를 불러오지 못했습니다.");
    } finally {
      if (version === searchVersion.current) setWaterBusy(false);
    }
  }
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      searchAbort.current?.abort();
      setWaterBusy(false);
      const b = m.getBounds();
      const covered = KINDS.every((kind) => {
        const box = foundLatest.current[kind]?.bbox;
        return box && box[0] <= b.getWest() && box[1] <= b.getSouth() && box[2] >= b.getEast() && box[3] >= b.getNorth();
      });
      // Do not let an old, large land polygon intercept clicks on roofs/water
      // whose details in the new viewport have not loaded yet.
      if (!covered) setFound({});
      setRoofLayer((previous) => {
        const box = previous?.bbox;
        return box && box[0] <= b.getWest() && box[1] <= b.getSouth() && box[2] >= b.getEast() && box[3] >= b.getNorth()
          ? previous : null;
      });
      if (b.getEast() - b.getWest() > .08 || b.getNorth() - b.getSouth() > .06) {
        setViewportHint("지도를 더 확대하면 누를 수 있는 건축물·지상·수상 경계가 함께 표시됩니다.");
        return;
      }
      setViewportHint("");
      setRoofStatus("loading");
      if (modeRef.current !== "view") return;
      timer = setTimeout(() => void loadFeatures(), 400);
    };
    m.on("moveend", refresh);
    refresh();
    return () => { clearTimeout(timer); m.off("moveend", refresh); searchAbort.current?.abort(); };
  }, [ready, mode]);

  useEffect(() => {
    if (!map.current || !ready || !pickedPoint) return;
    const marker = L.circleMarker([pickedPoint.latitude, pickedPoint.longitude], {
      radius: 6, color: "#fff", fillColor: "#f97316", fillOpacity: 1, weight: 2,
      interactive: false,
    }).addTo(map.current);
    return () => { marker.remove(); };
  }, [ready, pickedPoint?.latitude, pickedPoint?.longitude]);

  function navigate(location: SearchLocation) {
    const m = map.current;
    if (!m || latest.current.preparingSite) return;
    setTarget(location);
    selectionAbort.current?.abort();
    setSelectionError("");
    setPicked(null);
    setSiteTab("overview");
    setMode("view");
    setDraft([]);
    if (location.kind === "place") {
      m.setView([location.latitude, location.longitude], 17, { animate: false });
      return;
    }
    m.flyToBounds(toBounds(location.bbox), {
      padding: [40, 40],
      maxZoom: 13,
      duration: 0.8,
    });
  }
  useEffect(() => {
    if (!target || !map.current || !ready) return;
    const marker = L.circleMarker([target.latitude, target.longitude], {
      radius: 6,
      color: "#005596",
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
    if (climateMode === "generation") {
      const facilities = [...plants, ...assets];
      if (facilities.length) {
        map.current?.flyToBounds(facilities.map((facility) => [facility.latitude, facility.longitude] as [number, number]), { padding: [65, 65], maxZoom: 13, duration: .7 });
        setTarget(null);
        return;
      }
    }
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
  const regulationPanel = <><div className="climate-layer-controls" hidden={!climateMode}>
    <h3>{climateMode === "generation" ? "기존 태양광 시설" : "지도 표시 설정"}</h3>
    <p className="climate-control-caption">시설 유형</p>
    {([{ id: "building", label: "건축물·정수장", kind: "building" }, { id: "land", label: "지상 시설", kind: "land" },
      { id: "water", label: "수상 시설", kind: "water" }, { id: "other", label: "유형 미등록", kind: "building" }] as const).map(({ id, label: text, kind }) =>
      <label className={`climate-layer-row ${id}`} key={id}><input type="checkbox" checked={!facilityHidden.includes(id)} onChange={() => setFacilityHidden((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id])} />
        <i dangerouslySetInnerHTML={{ __html: typeIconSvg(kind, 15) }} />{text}</label>)}
    <p className="climate-control-caption">자료 출처</p>
    {([ ["kwater", "K-water 운영시설", plants.length], ["solartech", "등록 설비정보", assets.length] ] as const).map(([id, text, count]) =>
      <label className="climate-layer-row" key={id}><input type="checkbox" checked={!facilityHidden.includes(id)} onChange={() => setFacilityHidden((old) => old.includes(id) ? old.filter((value) => value !== id) : [...old, id])} />{text}<span>{count}</span></label>)}
    <p className="climate-control-caption">부지 경계</p>
    {KINDS.map((kind) => <label className="climate-layer-row" key={kind}><input type="checkbox" checked={!hidden.includes(kind)} onChange={() => setHidden((old) => old.includes(kind) ? old.filter((value) => value !== kind) : [...old, kind])} />
      <i className="boundary-key" style={{ background: FIND[kind].fill }} />{FIND[kind].label}<span>{layers[kind]?.total ?? "—"}</span></label>)}
    <label className="climate-opacity">경계 채우기<input aria-label="부지 경계 불투명도" type="range" min={0} max={80} value={overlayOpacity} onChange={(e) => setOverlayOpacity(Number(e.target.value))} /><span>{overlayOpacity}%</span></label>
    {climateMode === "potential" && <p className="climate-control-note">지도의 경계를 선택하면 해당 부지의 설치 잠재량을 계산합니다.</p>}
  </div><Regulations map={ready ? map.current : null} hiddenPanel={!!climateMode && climateMode !== "regulations"} showLayers target={activeFacility ? {
    name: activeFacility.name, latitude: activeFacility.latitude, longitude: activeFacility.longitude, geometry: null,
  } : picked ? {
    name: waterName(picked), latitude: picked.latitude, longitude: picked.longitude, geometry: picked.geometry,
  } : regionPoint ? { name: "선택 위치", latitude: regionPoint.latitude, longitude: regionPoint.longitude, geometry: null }
    : pickedPoint ? { name: "선택 좌표", ...pickedPoint, geometry: null } : candidate ? {
      name: candidate.name, latitude: candidate.latitude, longitude: candidate.longitude, geometry: candidate.geometry,
    } : null} /></>;
  const facilityCandidate: Candidate | null = activeFacility ? { id: activeFacility.id, project_id: "", name: activeFacility.name,
    latitude: activeFacility.latitude, longitude: activeFacility.longitude, geometry: null, exclusions: [], grid_point: null,
    cable_distance_m: null, water_depth_m: null, water_level_m: null,
    site_type: activeFacility.plant && activeFacility.plant.type !== "unknown" ? activeFacility.plant.type
      : activeFacility.kind === "water" ? "floating" : activeFacility.kind === "building" ? "building" : "land", source: activeFacility.source,
    reference_plant_id: activeFacility.source === "kwater" ? activeFacility.id : null,
    solartech_asset_id: activeFacility.source === "solartech" ? activeFacility.id : null } : null;
  const selectionProps: ComponentProps<typeof SelectedSite> = {
    site: picked ? (({ findKind: _kind, ...body }) => body)(picked) : null,
    regionPoint: activeFacility || regionPoint || (!picked && showSavedDetails ? candidate : null) || (climateMode ? center : null),
    siteType: pickedType, savedName: activeFacility?.name || (selectedSite?.name.startsWith("이름 없는 ") ? undefined : selectedSite?.name),
    savedCandidate: facilityCandidate || selectedSite, savedDesign: activeFacility ? undefined : selectedDesign,
    tab: !picked && !regionPoint && candidate && activeSiteTab === "overview" ? "potential" : activeSiteTab,
    onTab: setSiteTab, loading: selectionLoading, error: selectionError, run: activeFacility ? null : selectedRun,
    stale: selectionStale, pending: siteRuns.some((run) => run.status === "pending" || run.status === "running"), preparing: preparingSite,
    onContinue: onContinueSite ? (body) => onContinueSite(body, pickedType, selectedDesign?.id) : undefined,
    onClose: () => { selectionAbort.current?.abort(); setSelectionError(""); setPicked(null); setSiteTab("overview"); setShowSavedDetails(false); },
    onZoom: () => { const m = map.current; if (m) m.setZoom(Math.max(m.getZoom(), 17)); },
    onOpenGyeonggi: () => navigate({ id: "suwon-city-hall", label: "수원시청", latitude: 37.2635, longitude: 127.0288,
      bbox: [127.025, 37.26, 127.032, 37.267], source: "local", kind: "place" }),
  };
  useEffect(() => { if (infoPanel.current) infoPanel.current.scrollTop = 0; }, [picked?.id, regionPoint?.latitude, regionPoint?.longitude, activeSiteTab]);
  useEffect(() => {
    if (selectionLoading || (!picked && !regionPoint) || !window.matchMedia?.("(max-width: 800px)").matches) return;
    infoPanel.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [picked?.id, regionPoint?.latitude, regionPoint?.longitude, selectionLoading]);
  return (
    <div className={`map${climateMode ? ` climate-map view-${climateMode}` : ""}`}>
      {regulationContainer ? createPortal(regulationPanel, regulationContainer) : regulationContainer === undefined ? regulationPanel : null}
      <div className="map-toolbar">
        <MapSearch onSelect={navigate} />
        <div className="map-toolbar-actions">
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
      {!climateMode && <div className="map-discovery-note">
        <div className="map-object-toggles" role="group" aria-label="표시할 지도 경계">
          {KINDS.map((kind) => <label key={kind}>
            <input type="checkbox" checked={!hidden.includes(kind)} onChange={() => setHidden((old) =>
              old.includes(kind) ? old.filter((value) => value !== kind) : [...old, kind])} />
            <i style={{ background: FIND[kind].fill }} />{kind === "water" ? "수상" : FIND[kind].label}
            {layers[kind] && <span>{layers[kind]!.total}</span>}
          </label>)}
        </div>
        <span>표시된 경계를 바로 클릭하세요. 해당 건축물·지상·수상 자체를 기준으로 예측합니다.</span>
      </div>}
      <div className="map-feature-status" role="status">
        {plantError && <span>{plantError}</span>}
        {waterBusy ? <><span className="spinner" />건축물·지상·수상 경계를 함께 불러오는 중…</> : waterError ? <>
          <span>{waterError}</span><button className="btn" onClick={() => void loadFeatures()}>다시 불러오기</button>
        </> : viewportHint || `이 화면의 지도 경계 ${foundTotal}개 · 지도 이동·확대 시 자동으로 갱신됩니다.`}
        {!viewportHint && roofStatus === "loading" && <span>추가 건축물 경계 조회 중…</span>}
        {!viewportHint && roofStatus === "unavailable" && <span>추가 건축물 자료 연결 실패 · OpenStreetMap 경계 표시</span>}
      </div>
      {candidate && (
        <div className="map-modes" role="toolbar" aria-label="지도 편집 도구">
          {tools.map((t) => (
            <button
              key={t.id}
              aria-label={t.name}
              aria-pressed={mode === t.id}
              disabled={!ready}
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
      <div className="map-body">
      <div className="map-canvas">
        <div className="map-host" ref={host} aria-label="태양광 후보지 지도" />
        {climateMode && <div className="climate-map-title"><span>{climateMode === "potential" ? "설치 잠재량" : climateMode === "generation" ? "태양광 발전현황" : "규제요인 검토"}</span><small>{plants.length + assets.length}개 등록 시설 · 선택 부지 분석</small></div>}
        {climateMode && activeFacility && <div className="climate-map-popup"><FacilityPopup facility={activeFacility} onClose={() => setActiveFacility(null)}
          onReview={activeFacility.plant && onPickPlant ? () => { void onPickPlant(activeFacility.plant!).catch((cause) => setPlantError(String(cause))); setActiveFacility(null); } : undefined} /></div>}
        {climateMode && !activeFacility && picked && <div className="climate-map-popup"><SelectedSite {...selectionProps} tab="overview" /></div>}
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
      <aside className={`rank-panel${climateMode ? " climate-summary" : ""}`} aria-label="선택 부지 상세 정보" ref={infoPanel}>
        {climateMode === "regulations" ? <div className="climate-regulation-intro"><span>REGULATION CHECK</span><h3>선택 부지 규제 검토</h3><p>지도에서 경계를 선택하면 왼쪽 패널에서 전체 경계의 규제 중첩을 확인합니다.</p><ol><li>지도에서 부지 선택</li><li>규제 중첩·미확인 항목 확인</li><li>자료 출처에서 상세 조건 확인</li></ol><small>규제자료는 경기도 제공 범위입니다. 미확인 지역을 설치 가능으로 판정하지 않습니다.</small></div>
          : <SelectedSite {...selectionProps} key={picked ? `${picked.findKind}/${picked.id}` : regionPoint ? `${regionPoint.latitude}/${regionPoint.longitude}` : activeFacility?.id || candidate?.id || "no-selection"}
              summaryOnly={!!climateMode} tab={climateMode || selectionProps.tab} />}

      </aside>
      </div>
      <div className="map-legend">
        <label>
          색상 기준
          <select
            aria-label="지도 색상 지표"
            value={metric}
            onChange={(e) => setMetric(e.target.value as MapMetric)}
          >
            {Object.entries(metricDefinitions).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
                {value.unit ? ` (${value.unit})` : ""}
              </option>
            ))}
          </select>
        </label>
        <ul>
          {metric === "grade" && (
            <li>
              <i className="legend-top" />
              1순위 (진하게 표시)
            </li>
          )}
          {getMetricLegend(metric).map((item) => (
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
