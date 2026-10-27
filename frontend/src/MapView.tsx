import { useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  Candidate,
  MappedCandidate,
  Design,
  Polygon,
  Result,
  Run,
  WaterBody,
  WaterSearch,
} from "./types";
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
} from "./mapData";
import type { Grade, MapMetric, SiteRanking } from "./mapData";
type Mode = "view" | "polygon" | "exclusion" | "grid" | "edit";
type Basemap = "street" | "satellite" | "none";
type Props = {
  candidate: MappedCandidate | null;
  result: Result | null;
  candidates: MappedCandidate[];
  designs: Design[];
  runs: Run[];
  selectedDesignId?: string;
  onSelectCandidate: (id: string) => void;
  onAddCandidate: (position: { latitude: number; longitude: number }) => void;
  onUpdate: (data: Partial<Candidate>) => Promise<void>;
  onAnalyzeAll?: () => void;
  onAddWater?: (water: WaterBody) => void;
};
// Matches the server's per-request limit for the water body search.
const WATER_MAX = { width: 0.8, height: 0.6 };
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
const onWater = (c: MappedCandidate, waters: WaterBody[]) =>
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
  onAnalyzeAll,
  onAddWater,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    tiles = useRef<Record<Exclude<Basemap, "none">, L.TileLayer> | null>(null),
    latest = useRef({ candidate, onUpdate, onSelectCandidate });
  latest.current = { candidate, onUpdate, onSelectCandidate };
  const [mode, setMode] = useState<Mode>("view"),
    [draft, setDraft] = useState<number[][]>([]),
    [ready, setReady] = useState(false),
    [basemap, setBasemap] = useState<Basemap>("street"),
    [tileError, setTileError] = useState(false),
    [busy, setBusy] = useState(false),
    [mapError, setMapError] = useState("");
  const [metric, setMetric] = useState<MapMetric>("grade"),
    [target, setTarget] = useState<SearchLocation | null>(null),
    [center, setCenter] = useState({ latitude: 36.4, longitude: 127.8 });
  const [water, setWater] = useState<
    (WaterSearch & { bbox: [number, number, number, number] }) | null
  >(null),
    [waterBusy, setWaterBusy] = useState(false),
    [waterError, setWaterError] = useState(""),
    [picked, setPicked] = useState<WaterBody | null>(null),
    [panel, setPanel] = useState<"rank" | "water">("rank");
  const modeRef = useRef(mode),
    overview = useRef(true);
  modeRef.current = mode;
  const ranking = useMemo(
    () => rankCandidates(candidates, designs, runs),
    [candidates, designs, runs],
  );
  const counts = ranking.reduce(
    (acc, r) => {
      const g = r.stale ? "pending" : r.grade;
      acc[g] = (acc[g] || 0) + 1;
      return acc;
    },
    {} as Partial<Record<Grade, number>>,
  );
  const distribution = useMemo(
    () =>
      buildDistribution(candidates, designs, runs, metric, selectedDesignId),
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
      street.addTo(instance);
      tiles.current = { street, satellite };
      instance.on("click", (event: L.LeafletMouseEvent) => {
        const current = latest.current;
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
    setDraft([]);
    setTarget(null);
    // First visit: show every site so the ranking reads at a glance.
    const first = overview.current;
    overview.current = false;
    const bounds = candidate ? candidateBounds([candidate]) : null;
    if (first && candidates.length > 1)
      m.fitBounds(toBounds(candidateBounds(candidates) || KOREA), {
        padding: [70, 70],
        maxZoom: 13,
        animate: false,
      });
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
            latest.current.onSelectCandidate(c.id);
        };
        L.geoJSON(c.geometry, {
          style: {
            color: selected ? "#1d4ed8" : info.color,
            fillColor: info.color,
            fillOpacity: row.run ? 0.3 : 0.12,
            weight: selected ? 3 : 2,
            dashArray: row.stale ? "5 4" : undefined,
          },
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
        if (modeRef.current === "view") latest.current.onSelectCandidate(p.id);
      };
      // The selected site's module layout stays visible; its name is in the page header.
      const coversLayout = selected && !!result?.layout?.modules?.length;
      const site =
        metric === "none" || coversLayout
          ? undefined
          : candidates.find((c) => c.id === p.id);
      const polygon = L.geoJSON(f, {
        style: {
          color: selected ? "#1d4ed8" : p.color,
          fillColor: p.color,
          fillOpacity: available && metric !== "none" ? 0.35 : 0.12,
          weight: selected ? 3 : 1.5,
          dashArray: p.status === "stale" ? "5 4" : undefined,
        },
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
      if (site)
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
    if (mode === "edit")
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
          if (!current) return;
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
    if (!m || !ready || !water) return;
    const group = L.layerGroup().addTo(m);
    const [w, s, e, n] = water.bbox;
    L.rectangle(
      [
        [s, w],
        [n, e],
      ],
      {
        pane: "water",
        color: "#0369a1",
        weight: 1,
        dashArray: "6 6",
        fill: false,
        interactive: false,
      },
    ).addTo(group);
    for (const body of water.results) {
      const active = picked?.id === body.id;
      L.geoJSON(body.geometry, {
        pane: "water",
        style: {
          color: active ? "#0c4a6e" : "#0369a1",
          weight: active ? 3 : 1.5,
          fillColor: "#38bdf8",
          fillOpacity: active ? 0.55 : 0.35,
        },
        interactive: mode === "view",
      })
        .bindTooltip(
          label(waterName(body), `${body.kind} · ${hectares(body.area_m2)} ha`),
          { sticky: true, className: "map-label" },
        )
        .on("click", () => setPicked(body))
        .addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [water, picked, mode, ready]);
  async function findWater() {
    const m = map.current;
    if (!m) return;
    const b = m.getBounds(),
      c = m.getCenter();
    // Very wide views search the centre of the screen only.
    const halfW = Math.min((b.getEast() - b.getWest()) / 2, WATER_MAX.width / 2),
      halfH = Math.min((b.getNorth() - b.getSouth()) / 2, WATER_MAX.height / 2);
    const bbox: [number, number, number, number] = [
      c.lng - halfW,
      c.lat - halfH,
      c.lng + halfW,
      c.lat + halfH,
    ].map((v) => Math.round(v * 10000) / 10000) as [number, number, number, number];
    setWaterBusy(true);
    setWaterError("");
    setPicked(null);
    setPanel("water");
    try {
      const result = await api<WaterSearch>(
        `/water-bodies?west=${bbox[0]}&south=${bbox[1]}&east=${bbox[2]}&north=${bbox[3]}`,
      );
      setWater({ ...result, bbox });
    } catch (cause) {
      setWaterError(
        cause instanceof Error ? cause.message : "수면을 찾지 못했습니다.",
      );
    } finally {
      setWaterBusy(false);
    }
  }
  function showWater(body: WaterBody) {
    setPicked(body);
    const ring = body.geometry.coordinates[0];
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
          <button
            className="btn water"
            onClick={() => void findWater()}
            disabled={!ready || waterBusy}
            title="지금 보이는 지도 범위의 저수지·호수·연못(1 ha 이상)을 찾습니다"
          >
            {waterBusy && <span className="spinner" />}
            {waterBusy ? "수면 찾는 중…" : "이 지역 수면 찾기"}
          </button>
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
        <div className="map-host" ref={host} aria-label="수면 후보지 지도" />
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
          <div className="water-card">
            <div>
              <strong>{waterName(picked)}</strong>
              <span>
                {picked.kind} · {hectares(picked.area_m2)} ha
              </span>
            </div>
            {onAddWater && (
              <button
                className="btn primary"
                onClick={() => {
                  onAddWater(picked);
                  setPicked(null);
                }}
              >
                이 수면을 후보지로 추가
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
      <aside className="rank-panel" aria-label="후보지 사업성 순위">
        {(water || waterBusy || waterError) && (
          <div className="panel-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={panel === "rank"}
              className={panel === "rank" ? "active" : ""}
              onClick={() => setPanel("rank")}
            >
              사업성 순위
            </button>
            <button
              role="tab"
              aria-selected={panel === "water"}
              className={panel === "water" ? "active" : ""}
              onClick={() => setPanel("water")}
            >
              찾은 수면{water ? ` ${water.total}` : ""}
            </button>
          </div>
        )}
        {panel === "water" ? (
          <div className="water-list">
            {waterBusy ? (
              <p className="panel-status">
                <span className="spinner" />
                OpenStreetMap에서 저수지·호수 경계를 받는 중입니다. 처음 찾는
                지역은 30초~1분 걸릴 수 있습니다.
              </p>
            ) : waterError ? (
              <div className="panel-status error">
                {waterError}
                <button className="btn" onClick={() => void findWater()}>
                  다시 찾기
                </button>
              </div>
            ) : water && water.results.length ? (
              <>
                <p className="rank-note">
                  점선 사각형 안의 1 ha 이상 저수지·호수·연못입니다. 클릭하면
                  지도에서 보여 주고, 후보지로 추가할 수 있습니다.
                </p>
                <ol>
                  {water.results.map((body) => (
                    <li key={body.id}>
                      <button
                        className={picked?.id === body.id ? "active" : ""}
                        onClick={() => showWater(body)}
                      >
                        <span className="rank-body">
                          <b>{waterName(body)}</b>
                          <small>
                            {body.kind} · {hectares(body.area_m2)} ha
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                {water.total > water.results.length && (
                  <p className="rank-note">
                    면적이 큰 {water.results.length}곳만 표시합니다. 지도를
                    확대해 다시 찾으면 작은 수면도 볼 수 있습니다.
                  </p>
                )}
              </>
            ) : (
              <p className="panel-status">
                {water?.warning || "이 범위에서 수면을 찾지 못했습니다."}
              </p>
            )}
            {water && <p className="rank-note">{water.attribution}</p>}
          </div>
        ) : (
          <>
        <div className="rank-head">
          <h4>사업성 순위</h4>
          <span>B/C 높은 순</span>
        </div>
        <div className="rank-summary">
          {(Object.keys(gradeInfo) as Grade[])
            .filter((g) => counts[g])
            .map((g) => (
              <span
                key={g}
                style={{ color: gradeInfo[g].color, background: gradeInfo[g].soft }}
              >
                {gradeInfo[g].label} {counts[g]}
              </span>
            ))}
        </div>
        <ol>
          {ranking.map((row) => {
            const e = row.run?.result?.economics,
              info = gradeInfo[row.stale ? "pending" : row.grade];
            return (
              <li key={row.candidate.id}>
                <button
                  className={
                    (row.candidate.id === candidate?.id ? "active " : "") +
                    (row.rank === 1 ? "top" : "")
                  }
                  onClick={() => {
                    latest.current.onSelectCandidate(row.candidate.id);
                    if (row.candidate.id === candidate?.id) focus();
                  }}
                >
                  <span className="rank-no">{row.rank ?? "–"}</span>
                  <span className="rank-body">
                    <b>{row.candidate.name}</b>
                    <small>
                      {e
                        ? `B/C ${num(e.bc, 2)} · NPV ${num(e.npv / 100000000, 1)}억 원`
                        : row.stale
                          ? "조건이 바뀌어 다시 분석해야 합니다"
                          : "아직 분석하지 않았습니다"}
                    </small>
                    {row.design && <small>최적 대안: {row.design.name}</small>}
                    {water &&
                      !onWater(row.candidate, water.results) &&
                      inRing(row.candidate.longitude, row.candidate.latitude, [
                        [water.bbox[0], water.bbox[1]],
                        [water.bbox[2], water.bbox[1]],
                        [water.bbox[2], water.bbox[3]],
                        [water.bbox[0], water.bbox[3]],
                      ]) && (
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
          추천 = B/C 1.2 이상·NPV 0 초과. 사전 검토용 등급이며 인허가·계통·수심
          조건은 반영되지 않았습니다.
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
