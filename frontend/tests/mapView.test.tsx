import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as L from "leaflet";
import MapView from "../src/MapView";
import type { Candidate, Design, Result, Run } from "../src/types";
import { getMetricLegend, missingColor } from "../src/mapData";

// Exercise Leaflet's actual SVG/DOM implementation. jsdom does not provide a
// canvas or layout engine; these two browser capabilities are supplied explicitly.
const candidate: Candidate = {
  id: "c1", project_id: "p1", name: "수원 수면 후보지", latitude: 37.25, longitude: 127,
  geometry: { type: "Polygon", coordinates: [[[126.99, 37.24], [127.02, 37.24], [127.02, 37.27], [126.99, 37.24]]] },
  exclusions: [], grid_point: null, cable_distance_m: null, water_depth_m: null, water_level_m: null,
};
const design: Design = {
  id: "d1", project_id: "p1", candidate_id: "c1", name: "기본안",
  equipment: {}, costs: {}, finance: {}, sensitivity: {},
};
const run: Run = {
  id: "r1", design_id: "d1", project_id: "p1", status: "completed", created_at: "2026-01-01T00:00:00Z", error: null,
  snapshot: { candidate: structuredClone(candidate), design: structuredClone(design), project: { id: "p1", name: "예시", description: "", demo: true } },
  result: { annual_kwh: 825000, specific_yield: 1500, capacity_dc_kw: 550, economics: { bc: 1.25, npv: 120000000 } } as Result,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ stations: [] }) })));
  L.Browser.canvas = false;
  L.Browser.svg = true;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(510);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(510);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 900, height: 510, top: 0, left: 0, right: 900, bottom: 510,
    toJSON: () => ({}),
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderMap() {
  const setView = vi.spyOn(L.Map.prototype, "setView");
  const onSelectCandidate = vi.fn();
  const onAddCandidate = vi.fn();
  const onUpdate = vi.fn(async (_data: Partial<Candidate>) => {});
  const props = { candidate, result: null, candidates: [candidate], designs: [design], runs: [run], selectedDesignId: "d1", onSelectCandidate, onAddCandidate, onUpdate };
  const view = render(<MapView {...props}/>);
  const map = setView.mock.contexts[0] as L.Map;
  return { ...view, map, props, onSelectCandidate, onAddCandidate, onUpdate };
}

describe("Leaflet map runtime", () => {
  it("saves a clicked position as latitude/longitude and shifts the boundary with it", async () => {
    const { map, onUpdate } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "후보지 위치 지정" }));
    act(() => { map.fire("click", { latlng: L.latLng(36.8, 127.3) }); });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const payload = onUpdate.mock.calls[0][0];
    expect(payload.latitude).toBe(36.8);
    expect(payload.longitude).toBe(127.3);
    expect(payload.geometry!.coordinates[0][0][0]).toBeCloseTo(127.29);
    expect(payload.geometry!.coordinates[0][0][1]).toBeCloseTo(36.79);
    expect(candidate.latitude).toBe(37.25);
  });

  it("selects new site coordinates on the map and displays official weather station icons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ stations: [
      { stn: 108, name: "서울", latitude: 37.57142, longitude: 126.9658, has_observations: true },
    ] }) })));
    const { map, container, onAddCandidate } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "기상청 관측소 표시" }));
    await waitFor(() => expect(container.querySelector('[title="기상청 서울 (108)"]')).toBeTruthy());
    const marker = Object.values((map as unknown as { _layers: Record<string, L.Layer> })._layers)
      .find((layer) => layer instanceof L.Marker && layer.options.title === "기상청 서울 (108)") as L.Marker;
    expect(marker.getLatLng()).toEqual(L.latLng(37.57142, 126.9658));
    fireEvent.click(screen.getByRole("button", { name: "지도에서 새 위치 선택" }));
    act(() => { map.fire("click", { latlng: L.latLng(35.2, 129.1) }); });
    expect(onAddCandidate).toHaveBeenCalledWith({ latitude: 35.2, longitude: 129.1 });
  });

  it("opens satellite tiles with type icons and selectable individual boundaries, without rank labels", async () => {
    const { container, onSelectCandidate } = renderMap();
    await waitFor(() => expect(container.querySelectorAll("img.leaflet-tile").length).toBeGreaterThan(0));
    expect((container.querySelector("img.leaflet-tile") as HTMLImageElement).src).toContain("World_Imagery/MapServer/tile/");
    expect(container.querySelectorAll('path[fill="#38bdf8"]').length).toBe(1);
    const pin = container.querySelector(".saved-site-pin") as HTMLElement;
    expect(pin.title).toBe("수상: 수원 수면 후보지");
    expect(pin.querySelector("svg")).toBeTruthy();
    expect(container.querySelector(".site-pin")).toBeNull();
    expect(container.querySelector(".leaflet-marker-pane")!.textContent).not.toContain("순위");
    fireEvent.click(pin);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
    expect(screen.getAllByRole("button", { name: /수원 수면 후보지/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "선택한 대상 분석" }).textContent).toContain("825.0 MWh");
    // Metric views color the polygon; the type icon stays available.
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    const color = getMetricLegend("specific_yield")[3].color;
    const paths = container.querySelectorAll(`path[fill="${color}"]`);
    expect(paths.length).toBe(1);
    onSelectCandidate.mockClear();
    fireEvent.click(paths[0]);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
    expect((screen.getByRole("button", { name: "지도 확대" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("searches a region and moves the real viewport using west/south/east/north bounds", async () => {
    const location = { id: "suwon", label: "경기도 수원시", latitude: 37.2636, longitude: 127.0286, bbox: [126.9, 37.18, 127.12, 37.36], source: "local", kind: "region" };
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/weather/stations") ? { stations: [] } : ({ results: [location], provider: "local", warning: null, attribution: "지역명 사전" }) }));
    vi.stubGlobal("fetch", fetch);
    const { map, onAddCandidate } = renderMap();
    const before = map.getZoom();
    const flyToBounds = vi.spyOn(L.Map.prototype, "flyToBounds");
    fireEvent.change(screen.getByRole("textbox", { name: "지도 지역 검색" }), { target: { value: "수원시" } });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /경기도 수원시/ }));
    expect(fetch).toHaveBeenCalledWith("/api/geocoding/search?q=%EC%88%98%EC%9B%90%EC%8B%9C", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(flyToBounds).toHaveBeenLastCalledWith([[37.18, 126.9], [37.36, 127.12]], expect.objectContaining({ maxZoom: 13 }));
    await waitFor(() => {
      expect(map.getCenter().lat).toBeCloseTo(37.27, 2);
      expect(map.getCenter().lng).toBeCloseTo(127.01, 2);
    }, { timeout: 2500 });
    // The map opens fitted to the site boundary; a region result zooms out to city level.
    expect(map.getZoom()).toBeLessThanOrEqual(Math.max(before, 13));
    expect(map.getZoom()).toBeGreaterThanOrEqual(9);
    fireEvent.click(screen.getByRole("button", { name: "현재 지도 중심에 후보지 추가" }));
    expect(onAddCandidate).toHaveBeenCalledWith({ latitude: map.getCenter().lat, longitude: map.getCenter().lng });
  });

  it("accepts drawing points once, closes the polygon and saves longitude before latitude", async () => {
    const { map, onUpdate } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "후보 경계 그리기" }));
    act(() => {
      map.fire("click", { latlng: L.latLng(37.25, 127.01) });
      map.fire("click", { latlng: L.latLng(37.26, 127.02) });
      map.fire("click", { latlng: L.latLng(37.27, 127.01) });
    });
    fireEvent.click(screen.getByRole("button", { name: "경계 저장 (3)" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith({
      geometry: { type: "Polygon", coordinates: [[[127.01, 37.25], [127.02, 37.26], [127.01, 37.27], [127.01, 37.25]]] },
      latitude: (37.25 + 37.26 + 37.27) / 3,
      longitude: (127.01 + 127.02 + 127.01) / 3,
    });
  });

  it("repaints saved results gray when candidate inputs change without recreating the viewport", () => {
    const { container, map, props, rerender } = renderMap();
    const center = map.getCenter();
    const edited = { ...candidate, cable_distance_m: 800 };
    rerender(<MapView {...props} candidate={edited} candidates={[edited]}/>);
    fireEvent.click(container.querySelector(".saved-site-pin")!);
    expect(screen.getByRole("region", { name: "선택한 대상 분석" }).textContent).toContain("조건이 변경되었습니다");
    expect(screen.getByRole("region", { name: "선택한 대상 분석" }).textContent).not.toContain("825.0");
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    expect(container.querySelectorAll(`path[fill="${missingColor}"]`).length).toBe(1);
    expect(map.getCenter()).toEqual(center);
    expect(container.querySelectorAll(".leaflet-container").length).toBe(1);
  });

  it("finds real water bodies in view and turns a picked one into a candidate", async () => {
    const reservoir = {
      id: "relation/1", name: "예당저수지", kind: "저수지", area_m2: 9275000, latitude: 36.6, longitude: 126.8,
      geometry: { type: "Polygon", coordinates: [[[126.78, 36.58], [126.82, 36.58], [126.82, 36.62], [126.78, 36.58]]] },
    };
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/weather/stations") ? { stations: [] } : ({ results: [reservoir], total: 1, attribution: "© OpenStreetMap", warning: null }) }));
    vi.stubGlobal("fetch", fetch);
    const onAddSite = vi.fn();
    const setView = vi.spyOn(L.Map.prototype, "setView");
    render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAddSite={onAddSite}/>);
    const map = setView.mock.contexts[0] as L.Map;
    fireEvent.click(screen.getByRole("button", { name: "이 지역 수면 찾기" }));
    fireEvent.click(await screen.findByRole("button", { name: /^수상: 예당저수지$/ }));
    const [url] = fetch.mock.calls.find(([url]) => url.includes("/water-bodies"))!;
    const query = new URL(url, "http://x").searchParams;
    const bounds = map.getBounds();
    expect(Number(query.get("west"))).toBeGreaterThanOrEqual(bounds.getWest() - 1e-4);
    expect(Number(query.get("east")) - Number(query.get("west"))).toBeLessThanOrEqual(0.8);
    // The candidate sits outside every mapped water body in the searched area.
    fireEvent.click(screen.getByRole("tab", { name: "저장한 대상" }));
    expect(screen.getByText("지도상 수면 밖에 있습니다")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "이 수면을 후보지로 추가" }));
    expect(onAddSite).toHaveBeenCalledWith(reservoir, "water");
  });

  it("finds large roofs and open land too, each through its own search and site type", async () => {
    const roof = {
      id: "way/7", name: null, kind: "공장·산업시설", area_m2: 6573, latitude: 37.25, longitude: 127.0,
      geometry: { type: "Polygon", coordinates: [[[126.999, 37.249], [127.001, 37.249], [127.001, 37.251], [126.999, 37.249]]] },
    };
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/weather/stations") ? { stations: [] }
      : url.includes("kind=building") ? { results: [roof], total: 1, attribution: "© OpenStreetMap", warning: null }
      : { results: [], total: 0, attribution: "© OpenStreetMap", warning: "이 범위에서 2,000 m² 이상인 유휴 부지를 찾지 못했습니다." } }));
    vi.stubGlobal("fetch", fetch);
    const onAddSite = vi.fn();
    render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAddSite={onAddSite}/>);
    fireEvent.click(screen.getByRole("button", { name: "이 지역 건축물 찾기" }));
    fireEvent.click(await screen.findByRole("button", { name: /^건축물: 이름 없는 공장·산업시설$/ }));
    const [url] = fetch.mock.calls.find(([url]) => url.includes("/site-candidates"))!;
    const query = new URL(url, "http://x").searchParams;
    expect(Number(query.get("east")) - Number(query.get("west"))).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(screen.getByRole("tab", { name: /설치 가능 지역 1/ })).toBeTruthy();
    expect(screen.getAllByText(/6,573 m²/).length).toBeGreaterThan(0);
    // A roof search says nothing about whether a floating site sits on water.
    fireEvent.click(screen.getByRole("tab", { name: "저장한 대상" }));
    expect(screen.queryByText("지도상 수면 밖에 있습니다")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "이 건축물을 후보지로 추가" }));
    expect(onAddSite).toHaveBeenCalledWith(roof, "building");
    fireEvent.click(screen.getByRole("button", { name: "이 지역 지상 부지 찾기" }));
    expect(await screen.findByText(/유휴 부지를 찾지 못했습니다/)).toBeTruthy();
  });

  it("shows water, land and roofs together with a toggle and a pin per installation type", async () => {
    const shape = (x: number) => ({ type: "Polygon", coordinates: [[[x, 37.249], [x + 0.002, 37.249], [x + 0.002, 37.251], [x, 37.249]]] });
    const site = (id: string, name: string, kind: string, area_m2: number, x: number) =>
      ({ id, name, kind, area_m2, latitude: 37.25, longitude: x + 0.001, geometry: shape(x) });
    const pond = site("way/1", "원천저수지", "저수지", 250000, 126.99),
      lot = site("way/2", "공영주차장", "주차장", 4200, 127.0),
      roof = site("way/3", "물류센터", "창고·물류시설", 6573, 127.01);
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/weather/stations") ? { stations: [] }
      : { results: [url.includes("/water-bodies") ? pond : url.includes("kind=land") ? lot : roof], total: 1, attribution: "© OpenStreetMap", warning: null } }));
    vi.stubGlobal("fetch", fetch);
    const onAddSite = vi.fn();
    const { container } = render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAddSite={onAddSite}/>);
    fireEvent.click(screen.getByRole("button", { name: "이 지역 설치 가능 지역 모두 찾기" }));
    expect(await screen.findByRole("tab", { name: /설치 가능 지역 3/ })).toBeTruthy();
    // One request per server-sized tile; the same site from two tiles is listed once.
    expect(fetch.mock.calls.filter(([url]) => /water-bodies|site-candidates/.test(url)).length).toBeGreaterThanOrEqual(3);
    // Every type is drawn at once in its own colour, with a pin on each site.
    for (const fill of ["#38bdf8", "#facc15", "#c084fc"]) expect(container.querySelectorAll(`path[fill="${fill}"]`).length).toBeGreaterThanOrEqual(1);
    expect([...container.querySelectorAll(".find-pin:not(.saved-site-pin)")].map((pin) => pin.getAttribute("title")).sort())
      .toEqual(["건축물: 물류센터", "수상: 원천저수지", "지상: 공영주차장"]);
    expect(container.querySelectorAll(".find-pin svg path").length).toBeGreaterThan(0);
    expect(screen.getByText("창고·물류시설 1")).toBeTruthy();
    // Unticking a type removes its outlines, pins and list rows only.
    fireEvent.click(screen.getByRole("checkbox", { name: "건축물 표시" }));
    expect(container.querySelectorAll('path[fill="#c084fc"]').length).toBe(0);
    expect(container.querySelectorAll(".find-pin:not(.saved-site-pin)").length).toBe(2);
    expect(screen.queryByRole("button", { name: /물류센터/ })).toBeNull();
    // A pin picks its site with the right type for the candidate form.
    fireEvent.click(container.querySelector(".leaflet-marker-icon.find-pin-land")!);
    fireEvent.click(screen.getByRole("button", { name: "이 부지를 후보지로 추가" }));
    expect(onAddSite).toHaveBeenCalledWith(lot, "land");
  });

  it("covers a wide view with several tiles, keeps earlier results and offers a search after panning", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/weather/stations")) return { ok: true, status: 200, json: async () => ({ stations: [] }) };
      const q = new URL(url, "http://x").searchParams, x = Number(q.get("west")) + 0.01, y = Number(q.get("south")) + 0.01;
      n += 1;
      const body = { id: `way/${n}`, name: `저수지 ${n}`, kind: "저수지", area_m2: 50000 + n, latitude: y, longitude: x,
        geometry: { type: "Polygon", coordinates: [[[x, y], [x + 0.005, y], [x + 0.005, y + 0.005], [x, y]]] } };
      return { ok: true, status: 200, json: async () => ({ results: [body], total: 1, attribution: "© OpenStreetMap", warning: null }) };
    });
    vi.stubGlobal("fetch", fetch);
    const setView = vi.spyOn(L.Map.prototype, "setView");
    const { container } = render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAddSite={vi.fn()}/>);
    const map = setView.mock.contexts[0] as L.Map;
    act(() => { map.setView([36.5, 127.5], 8, { animate: false }); });
    const water = () => fetch.mock.calls.map(([url]) => url as string).filter((url) => url.includes("/water-bodies"));
    fireEvent.click(screen.getByRole("button", { name: "이 지역 수면 찾기" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /설치 가능 지역 6/ })).toBeTruthy());
    // The wide view is split into server-sized tiles, at most six per search.
    expect(water().length).toBe(6);
    for (const url of water()) {
      const q = new URL(url, "http://x").searchParams;
      expect(Number(q.get("east")) - Number(q.get("west"))).toBeLessThanOrEqual(0.8);
      expect(Number(q.get("north")) - Number(q.get("south"))).toBeLessThanOrEqual(0.6);
    }
    expect(screen.getByText(/가운데 6칸만 찾았습니다/)).toBeTruthy();
    expect(container.querySelectorAll(".find-pin:not(.saved-site-pin)").length).toBe(6);
    // Panning to an unsearched region offers the same search; results add up.
    act(() => { map.setView([35.2, 129.0], 11, { animate: false }); });
    fireEvent.click(await screen.findByRole("button", { name: /이 위치에서 다시 찾기/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /설치 가능 지역 7/ })).toBeTruthy());
    expect(container.querySelectorAll(".find-pin:not(.saved-site-pin)").length).toBe(7);
    expect(screen.queryByRole("button", { name: /이 위치에서 다시 찾기/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "찾은 결과 모두 지우기" }));
    expect(container.querySelectorAll(".find-pin:not(.saved-site-pin)").length).toBe(0);
  });

  it("pins a site that has no boundary and labels every site with its installation type", () => {
    const plant: Candidate = { ...candidate, id: "c2", name: "아산정수장", geometry: null, site_type: "plant", latitude: 36.79, longitude: 127.0 };
    const onSelectCandidate = vi.fn();
    const { container } = render(<MapView candidate={plant} result={null} candidates={[candidate, plant]} designs={[design]} runs={[run]}
      onSelectCandidate={onSelectCandidate} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})}/>);
    const pins = [...container.querySelectorAll(".saved-site-pin")].map((pin) => pin.getAttribute("title"));
    expect(pins).toContain("수상: 수원 수면 후보지");
    expect(pins).toContain("정수장: 아산정수장");
    expect(container.querySelectorAll(".type-chip").length).toBe(2);
    expect((screen.getByRole("button", { name: "경계 꼭짓점 수정" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(container.querySelector('[title="수상: 수원 수면 후보지"]')!);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
  });

  it("opens a saved boundary's analysis and runs only that target, keeping type filters in sync", async () => {
    const onAnalyzeCandidate = vi.fn(async () => {});
    const { container } = render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAnalyzeCandidate={onAnalyzeCandidate}/>);
    fireEvent.click(container.querySelector('path[fill="#38bdf8"]')!);
    expect(screen.getByRole("region", { name: "선택한 대상 분석" }).textContent).toContain("825.0 MWh");
    fireEvent.click(screen.getByRole("button", { name: "다시 분석", exact: true }));
    await waitFor(() => expect(onAnalyzeCandidate).toHaveBeenCalledWith("c1"));
    fireEvent.click(screen.getByRole("button", { name: "수상 지도 표시" }));
    expect(container.querySelector(".saved-site-pin")).toBeNull();
    expect(container.querySelector('path[fill="#38bdf8"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "수상 지도 표시" }));
    expect(container.querySelector(".saved-site-pin")).toBeTruthy();
  });

  it("shows the selected design's result when another design has a higher B/C", () => {
    const alternate = { ...design, id: "d2", name: "선택한 설계" };
    const alternateRun = { ...run, id: "r2", design_id: "d2", snapshot: { ...run.snapshot, design: alternate },
      result: { ...run.result!, annual_kwh: 200000, economics: { ...run.result!.economics, bc: 0.8 } } };
    const { container } = render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design, alternate]} runs={[run, alternateRun]} selectedDesignId="d2"
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})}/>);
    fireEvent.click(container.querySelector(".saved-site-pin")!);
    const detail = screen.getByRole("region", { name: "선택한 대상 분석" });
    expect(detail.textContent).toContain("200.0 MWh");
    expect(detail.textContent).toContain("0.80");
    expect(detail.textContent).toContain("선택한 설계");
    expect(detail.textContent).not.toContain("825.0");
  });

  it("does not restore results delivered after the user stops a map search", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/weather/stations")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ stations: [] }) })
      : new Promise((resolve) => { finish = resolve; })));
    const { container } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "이 지역 건축물 찾기" }));
    fireEvent.click(screen.getByRole("button", { name: "중지", exact: true }));
    await act(async () => { finish({ ok: true, status: 200, json: async () => ({ results: [{ id: "late", geometry: candidate.geometry,
      name: "늦게 온 건축물", kind: "건축물", area_m2: 90, latitude: 37.25, longitude: 127 }], total: 1, attribution: "OSM", warning: null }) }); });
    expect(container.querySelector(".leaflet-marker-icon.find-pin-building")).toBeNull();
    expect((screen.getByRole("checkbox", { name: "주변 자동 표시" }) as HTMLInputElement).checked).toBe(false);
  });

  it("automatically loads individual outlines after zooming in and analyzes a clicked roof", async () => {
    const roof = { id: "way/44", name: "작은 주택", kind: "건축물", area_m2: 90, latitude: 37.25, longitude: 127,
      geometry: { type: "Polygon", coordinates: [[[127, 37.25], [127.0001, 37.25], [127.0001, 37.2501], [127, 37.25]]] } };
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/weather/stations") ? { stations: [] }
      : { results: url.includes("kind=building") ? [roof] : [], total: url.includes("kind=building") ? 1 : 0, attribution: "OSM", warning: null } }));
    vi.stubGlobal("fetch", fetch);
    const onAnalyzeSite = vi.fn(async () => {});
    const setView = vi.spyOn(L.Map.prototype, "setView");
    const { container } = render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAnalyzeSite={onAnalyzeSite}/>);
    const map = setView.mock.contexts[0] as L.Map;
    act(() => { map.setView([37.25, 127], 17, { animate: false }); });
    await waitFor(() => expect(container.querySelector(".leaflet-marker-icon.find-pin-building")).toBeTruthy(), { timeout: 2500 });
    expect(fetch.mock.calls.some(([url]) => url.includes("/water-bodies"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes("kind=land"))).toBe(true);
    fireEvent.click(container.querySelector('path[fill="#c084fc"]')!);
    expect(screen.getByRole("region", { name: "선택한 지도 대상" }).textContent).toContain("90 m²");
    fireEvent.click(screen.getAllByRole("button", { name: "이 대상 분석하기", exact: true })[0]);
    await waitFor(() => expect(onAnalyzeSite).toHaveBeenCalledWith(roof, "building"));
  });
});
