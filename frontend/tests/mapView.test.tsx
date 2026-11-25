import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as L from "leaflet";
import MapView from "../src/MapView";
import type { MapSelection } from "../src/MapView";
import type { Candidate, Design, Polygon, Result, Run } from "../src/types";
import { getMetricLegend, gradeInfo, missingColor } from "../src/mapData";

const polygon = (x: number, y: number): Polygon => ({ type: "Polygon", coordinates: [
  [[x, y], [x + .0006, y], [x + .0006, y + .0006], [x, y + .0006], [x, y]],
] });
const candidate: Candidate = {
  id: "c1", project_id: "p1", name: "수원 기존 후보지", latitude: 37.25, longitude: 127,
  geometry: polygon(126.999, 37.25), site_type: "floating", source: "테스트",
  exclusions: [], grid_point: null, cable_distance_m: null, water_depth_m: null, water_level_m: null, reference_plant_id: null,
};
const design: Design = { id: "d1", project_id: "p1", candidate_id: "c1", name: "기본안", equipment: {}, costs: {}, finance: {} };
const run: Run = {
  id: "r1", design_id: "d1", project_id: "p1", status: "completed", created_at: "2026-01-01T00:00:00Z", error: null,
  snapshot: { candidate: structuredClone(candidate), design: structuredClone(design), project: { id: "p1", name: "예시", description: "", demo: true } },
  result: { annual_kwh: 825000, specific_yield: 1500, capacity_dc_kw: 550, economics: { bc: 1.25, npv: 120000000 } } as Result,
};
const objects = [
  { id: "way/1", feature_type: "building", name: "업무동", kind: "업무시설", area_m2: 3000, latitude: 37.2493, longitude: 126.9983,
    geometry: polygon(126.998, 37.249), building_info: { address: "경기도 수원시 테스트로 10", levels: "5", height: "18", roof_shape: "flat" } },
  { id: "way/2", feature_type: "water", name: "연못", kind: "연못", area_m2: 500, latitude: 37.2493, longitude: 127.0003, geometry: polygon(127, 37.249) },
  { id: "way/3", feature_type: "land", name: "농지", kind: "농지", area_m2: 900, latitude: 37.2493, longitude: 127.0023, geometry: polygon(127.002, 37.249) },
] as const;
const response = (value: unknown) => new Response(JSON.stringify(value));
const regionalLocation = { status: "available", location: { district: "수원시 팔달구", administrative: "인계동", legal: "인계동" } };
function mockApi(rows: readonly unknown[] = []) {
  const fetch = vi.fn(async (url: string) => response(url.includes("regulations/catalog") ? { configured: false, layers: [], notice: "미연결" }
    : url.endsWith("/plants") ? { plants: [] }
    : url.endsWith("/solar-status") ? { scope_label: "선택 범위", facilities: [], notice: "등록 운영실적" }
    : url.endsWith("/solar-potential") ? { status: "available", specific_yield: 1240, capacity_dc_kw: 100,
      annual_kwh: 124000, module_count: 224, references: [], capacity_basis: "경계 면적 기준", notice: "등록 운영실적 기반 예비 추정" }
    : url.includes("/roofprints?") ? { results: [], attribution: "Overture" }
    : url.includes("/map-features?") ? { results: rows, total: rows.length, attribution: "OSM", warning: null }
    : url.includes("/guideline/site?") ? { province: "경기도", nearest_city: "수원", optimal_tilt: 31, weather_station: { name: "수원", distance_km: 2.5 } }
    : url.includes("/solar-region/location?") ? regionalLocation
    : url.includes("/solar-region?") ? { ...regionalLocation, source_url: "https://climate.gg.go.kr/ips/engy/solar-adoption",
      potential: { theoretical: { ground_mwh: 8819170, roof_mwh: 770040 }, technical: { ground_mwh: 223770, roof_mwh: 38500 },
        market: { ground_mwh: 1340, roof_mwh: 38400 } },
      district_potential: { name: "수원시 팔달구", ground_mwh: 28771610, roof_mwh: null },
      generation: { annual_kwh: 9060000, panel_area_m2: 39600, rank: 1, rank_area: "수원시" },
      generation_mix: [{ name: "공동주택", annual_kwh: 1420000 }] }
    : { feature: null, warning: "등록된 경계가 없습니다." }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
beforeEach(() => {
  L.Browser.canvas = false; L.Browser.svg = true;
  for (const name of ["clientWidth", "offsetWidth"] as const) vi.spyOn(HTMLElement.prototype, name, "get").mockReturnValue(900);
  for (const name of ["clientHeight", "offsetHeight"] as const) vi.spyOn(HTMLElement.prototype, name, "get").mockReturnValue(510);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 900, height: 510, top: 0, left: 0, right: 900, bottom: 510, toJSON: () => ({}),
  });
  mockApi();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderMap(extra: Partial<React.ComponentProps<typeof MapView>> = {}) {
  const setView = vi.spyOn(L.Map.prototype, "setView");
  const onSelectCandidate = vi.fn(), onAddCandidate = vi.fn(), onContinueSite = vi.fn(async () => {});
  const onUpdate = vi.fn(async (_data: Partial<Candidate>) => {});
  const props = { candidate, result: null, candidates: [candidate], designs: [design], runs: [run], selectedDesignId: "d1",
    onSelectCandidate, onAddCandidate, onUpdate, onContinueSite, ...extra };
  function ControlledMap(next: typeof props) {
    const [selection, onPick] = React.useState<MapSelection>(null);
    return <MapView {...next} selection={selection} onPick={onPick} />;
  }
  const view = render(<ControlledMap {...props} />);
  const map = setView.mock.contexts[0] as L.Map;
  return { ...view, map, props, onSelectCandidate, onAddCandidate, onUpdate, onContinueSite,
    rerender: (next: typeof props) => view.rerender(<ControlledMap {...next} />) };
}
describe("selectable map objects", () => {
  it("opens the design step for a roof omitted by OSM while surface data is pending", async () => {
    const roof = { ...objects[0], id: "overture/new", name: "추가 옥상", data_source: "Overture Maps Foundation" };
    const fetch = mockApi();
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => url.includes("/roofprints?") ? response({ results: [roof], attribution: "Overture" })
      : url.includes("/map-features?") ? new Promise<Response>(() => {}) : fallback(url));
    const { container, onContinueSite } = renderMap();
    await waitFor(() => expect(container.querySelector(".object-building")).toBeTruthy());
    fireEvent.click(container.querySelector(".object-building")!);
    await screen.findByRole("heading", { name: "추가 옥상" });
    expect(onContinueSite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다음 · 설계 조건 입력" }));
    const { feature_type, ...selected } = roof;
    expect(onContinueSite).toHaveBeenCalledWith(selected, "building", undefined);
  });
  it("shows the exact clicked object before continuing to design without a search or type selection", async () => {
    const fetch = mockApi(objects);
    const { container, onContinueSite } = renderMap();
    await waitFor(() => expect(container.querySelectorAll(".map-object").length).toBe(3), { timeout: 5000 });
    expect(screen.queryByRole("combobox", { name: "찾을 후보 종류" })).toBeNull();
    expect(screen.queryByRole("button", { name: /이 지역.*찾기/ })).toBeNull();
    for (const name of ["건축물", "지상 부지", "수상"]) expect((screen.getByRole("checkbox", { name: new RegExp(name) }) as HTMLInputElement).checked).toBe(true);
    for (const [index, object] of objects.entries()) {
      fireEvent.click(container.querySelector(`.map-object.object-${object.feature_type}`)!);
      await screen.findByRole("heading", { name: object.name });
      expect(screen.getByText("이 부지에 저장된 분석 결과가 없습니다.")).toBeTruthy();
      expect(onContinueSite).toHaveBeenCalledTimes(index);
      fireEvent.click(screen.getByRole("button", { name: "다음 · 설계 조건 입력" }));
      const { feature_type, ...body } = object;
      expect(onContinueSite).toHaveBeenLastCalledWith(body, feature_type === "water" ? "floating" : feature_type, undefined);
    }
    expect(fetch.mock.calls.some(([url]) => url.includes("/map-features?"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes("/identify?"))).toBe(false);
  });
  it.each(objects)("identifies $feature_type at an unprefetched point without changing selection mode", async (object) => {
    const fetch = mockApi();
    fetch.mockImplementation(async (url: string) => response(url.includes("/map-features/identify?")
      ? { feature: object, warning: null, attribution: "OSM" }
      : url.includes("/map-features?") ? { results: [], total: 0, attribution: "OSM", warning: null }
      : url.includes("regulations/catalog") ? { configured: false, layers: [], notice: "미연결" }
      : { province: "경기도", nearest_city: "수원", optimal_tilt: 31 }));
    const { map, onContinueSite } = renderMap();
    act(() => { map.fire("click", { latlng: L.latLng(object.latitude, object.longitude) }); });
    await screen.findByRole("heading", { name: object.name });
    fireEvent.click(screen.getByRole("button", { name: "다음 · 설계 조건 입력" }));
    const { feature_type, ...body } = object;
    expect(onContinueSite).toHaveBeenCalledWith(body, feature_type === "water" ? "floating" : feature_type, undefined);
  });
  it("shows building facts and completed predictions alongside the selected roof", async () => {
    mockApi(objects);
    const { container, props, rerender, onContinueSite } = renderMap();
    await waitFor(() => expect(container.querySelector(".object-building")).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(container.querySelector(".object-building")!);
    await screen.findByText("수원 · 2.5 km");
    expect(screen.getByText("경기도 수원시 테스트로 10")).toBeTruthy();
    expect(screen.getByText("5층")).toBeTruthy();
    expect(screen.getByText("평지붕")).toBeTruthy();
    const saved = { ...candidate, id: "c2", name: "업무동", site_type: "building" as const, geometry: objects[0].geometry,
      latitude: objects[0].latitude, longitude: objects[0].longitude,
      source: "건축물 외곽 · way/1 · 0.3 ha" };
    const savedDesign = { ...design, id: "d2", candidate_id: saved.id };
    const completed = { ...run, design_id: "d2", snapshot: { ...run.snapshot, candidate: saved, design: savedDesign } };
    const failed: Run = { ...completed, id: "r2", status: "failed", created_at: "2026-01-02T00:00:00Z", result: null };
    rerender({ ...props, candidate: saved, candidates: [candidate, saved], designs: [design, savedDesign], runs: [failed, completed] });
    const panel = within(screen.getByRole("region", { name: "선택 위치 정보" }));
    expect(panel.getByText("825.0")).toBeTruthy();
    expect(panel.getByText("1.25")).toBeTruthy();
    expect(onContinueSite).not.toHaveBeenCalled();
    fireEvent.click(panel.getByRole("button", { name: "다음 · 설계 조건 입력" }));
    expect(onContinueSite).toHaveBeenCalledWith(expect.objectContaining({ id: "way/1" }), "building", "d2");
    rerender({ ...props, candidate: saved, candidates: [candidate, saved],
      designs: [design, { ...savedDesign, equipment: { area_use_pct: 25 } }], runs: [completed] });
    expect(panel.getByText(/이전 조건으로 계산한 결과/)).toBeTruthy();
    expect(panel.getByText("825.0")).toBeTruthy();
    fireEvent.click(container.querySelector(".object-water")!);
    const nextPanel = within(screen.getByRole("region", { name: "선택 위치 정보" }));
    expect(nextPanel.getByText("이 부지에 저장된 분석 결과가 없습니다.")).toBeTruthy();
    expect(nextPanel.queryByText("825.0")).toBeNull();
    expect(container.querySelector(".leaflet-container")).toBeTruthy();
  });
  it("opens regional statistics for a point without a mapped object", async () => {
    const { map, onContinueSite } = renderMap();
    act(() => { map.fire("click", { latlng: L.latLng(37.25, 127) }); });
    await screen.findByRole("heading", { name: "수원시 팔달구 인계동", level: 3 });
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getAllByText("8,819.17 GWh").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "발전현황", exact: true }));
    expect(screen.getByText("9.06 GWh")).toBeTruthy();
    expect(screen.getByText("3.96 ha")).toBeTruthy();
    expect(screen.getByText("공동주택")).toBeTruthy();
    expect(screen.getByRole("region", { name: "규제지역 확인" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "규제요인", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "다음 · 설계 조건 입력" })).toBeNull();
    expect(onContinueSite).not.toHaveBeenCalled();
  });
  it("uses the mapped building name and falls back to the selected neighborhood for an unnamed roof", async () => {
    mockApi([objects[0], { ...objects[1], feature_type: "building", name: null }]);
    const { container } = renderMap();
    await waitFor(() => expect(container.querySelectorAll(".object-building")).toHaveLength(2));
    const roofs = container.querySelectorAll(".object-building");
    fireEvent.click(roofs[0]);
    expect(await screen.findByRole("heading", { name: "업무동" })).toBeTruthy();
    expect(await screen.findByText("수원시 팔달구 인계동")).toBeTruthy();
    fireEvent.click(roofs[1]);
    expect(await screen.findByRole("heading", { name: "인계동 건축물" })).toBeTruthy();
  });
  it("opens roof details first when regional statistics are unavailable", async () => {
    const fetch = mockApi([objects[0], { ...objects[1], feature_type: "building" }]);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => url.includes("/solar-region/location?")
      ? response({ status: "outside", location: null }) : fallback(url));
    const { container } = renderMap();
    await waitFor(() => expect(container.querySelectorAll(".object-building")).toHaveLength(2));
    const [roof, nextRoof] = container.querySelectorAll(".object-building");
    fireEvent.click(roof);
    expect(await screen.findByText("경기도 수원시 테스트로 10")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다음 · 설계 조건 입력" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "잠재량" }));
    expect(await screen.findByText("124.0")).toBeTruthy();
    expect(screen.queryByText(/이 지역의 태양광 집계 자료는 제공되지 않습니다/)).toBeNull();
    fireEvent.click(nextRoof);
    expect(screen.getByRole("button", { name: "부지 정보" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "다음 · 설계 조건 입력" })).toBeTruthy();
  });
  it("predicts from registered records when the district cannot be matched", async () => {
    const fetch = mockApi(objects);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => url.includes("/solar-region/location?")
      ? response({ status: "unmatched", location: { district: "수원시", administrative: null, legal: null } })
      : fallback(url));
    const { container } = renderMap();
    await waitFor(() => expect(container.querySelector(".object-building")).toBeTruthy());
    fireEvent.click(container.querySelector(".object-building")!);
    fireEvent.click(screen.getByRole("button", { name: "잠재량" }));
    expect(await screen.findByText("124.0")).toBeTruthy();
    expect(screen.queryByText("선택한 위치에 해당하는 읍·면·동 통계를 찾지 못했습니다.")).toBeNull();
  });
  it("shows facilities as clickable icons and places regulation controls in the sidebar destination", async () => {
    const plant = { id: "plant1", name: "등록 정수장", latitude: candidate.latitude, longitude: candidate.longitude,
      type: "plant", capacity_kw: 500 };
    const fetch = mockApi();
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => url.endsWith("/plants") ? response({ plants: [plant] }) : fallback(url));
    const regulationContainer = document.createElement("div");
    document.body.append(regulationContainer);
    const onPickPlant = vi.fn(async () => {});
    const { container, unmount } = renderMap({ regulationContainer, onPickPlant });
    await waitFor(() => expect(container.querySelector(".kwater-facility-icon")).toBeTruthy());
    expect(within(regulationContainer).getByRole("region", { name: "규제지역 확인" })).toBeTruthy();
    expect(container.querySelector(".regulation-panel")).toBeNull();
    expect(screen.queryByText("사업성 순위")).toBeNull();
    expect(container.querySelector(".panel-tabs")).toBeNull();
    fireEvent.click(container.querySelector(".kwater-facility-icon")!);
    expect(onPickPlant).toHaveBeenCalledWith(plant);
    unmount();
    regulationContainer.remove();
  });
  it("allows visibility toggles without changing which types are loaded", async () => {
    const fetch = mockApi(objects);
    const { container } = renderMap();
    await waitFor(() => expect(container.querySelectorAll(".map-object").length).toBe(3), { timeout: 5000 });
    fireEvent.click(screen.getByRole("checkbox", { name: /건축물/ }));
    expect(container.querySelector(".object-building")).toBeNull();
    expect(container.querySelector(".object-land")).toBeTruthy();
    expect(container.querySelector(".object-water")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /건축물/ }));
    expect(container.querySelector(".object-building")).toBeTruthy();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/map-features?"))).toHaveLength(1);
  });
  it("removes stale hit areas after panning so an old land polygon cannot select a newly visible roof", async () => {
    const roof = { ...objects[0], id: "way/new-roof", name: "이동한 화면의 건물", latitude: 37.2533, longitude: 127.0153,
      geometry: polygon(127.015, 37.253) };
    const fetch = mockApi(objects);
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => {
      if (url.includes("/map-features/identify?")) return response({ feature: roof, warning: null, attribution: "OSM" });
      if (url.includes("/map-features?") && Number(new URL(url, "http://test").searchParams.get("west")) > 127.005)
        return new Promise<Response>(() => {});
      return fallback(url);
    });
    const { container, map } = renderMap();
    await waitFor(() => expect(container.querySelectorAll(".map-object").length).toBe(3), { timeout: 5000 });
    act(() => { map.setView([37.2533, 127.0153], 16, { animate: false }); });
    expect(container.querySelectorAll(".map-object").length).toBe(0);
    act(() => { map.fire("click", { latlng: L.latLng(roof.latitude, roof.longitude) }); });
    await screen.findByRole("heading", { name: "이동한 화면의 건물" });
  });
});
describe("climate-style map workspace", () => {
  it("opens an installed facility popup and changes views without recreating the map", async () => {
    const fetch = mockApi();
    const fallback = fetch.getMockImplementation()!;
    const asset = { id: "asset1", name: "등록 옥상 발전소", latitude: 37.25, longitude: 127, capacity_kw: 42, site_type_raw: "건축물", address: "등록 주소" };
    fetch.mockImplementation(async (url) => url.endsWith("/solartech/assets") ? response({ assets: [asset] }) : fallback(url));
    const regulationContainer = document.createElement("div");
    document.body.append(regulationContainer);
    const onPickPlant = vi.fn(async () => {});
    const { container, map, props, rerender, unmount } = renderMap({ climateMode: "generation", regulationContainer, onPickPlant });
    await waitFor(() => expect(container.querySelector(".climate-facility-pin")).toBeTruthy());
    expect(container.querySelectorAll(".climate-summary")).toHaveLength(1);
    fireEvent.click(container.querySelector(".climate-facility-pin")!);
    const popup = within(await screen.findByRole("region", { name: "발전소 정보" }));
    expect(popup.getByText("등록 주소")).toBeTruthy();
    expect(onPickPlant).not.toHaveBeenCalled();
    fireEvent.click(popup.getByRole("button", { name: "발전소 정보 닫기" }));
    rerender({ ...props, climateMode: "potential" });
    expect(container.querySelector(".view-potential")).toBeTruthy();
    expect(await screen.findByText("124.0")).toBeTruthy();
    rerender({ ...props, climateMode: "regulations" });
    expect(within(regulationContainer).getByRole("region", { name: "규제지역 확인" })).toBeTruthy();
    expect(container.querySelectorAll(".leaflet-container")).toHaveLength(1);
    expect(map.getZoom()).toBeGreaterThanOrEqual(14);
    unmount();
    regulationContainer.remove();
  });
});

describe("Leaflet runtime and geometry editing", () => {
  it("opens satellite imagery, keeps OSM available, and selects colored candidate SVGs", async () => {
    const { container, onSelectCandidate } = renderMap();
    await waitFor(() => expect(container.querySelectorAll("img.leaflet-tile").length).toBeGreaterThan(0));
    expect((container.querySelector("img.leaflet-tile") as HTMLImageElement).src).toContain("World_Imagery");
    fireEvent.click(screen.getByRole("button", { name: "일반" }));
    await waitFor(() => expect((container.querySelector("img.leaflet-tile") as HTMLImageElement).src).toMatch(/^https:\/\/tile\.openstreetmap\.org\//));
    expect(container.querySelectorAll(`path[fill="${gradeInfo.recommended.color}"]`).length).toBe(1);
    fireEvent.click(container.querySelector(".site-pin")!);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    expect(container.querySelectorAll(`path[fill="${getMetricLegend("specific_yield")[3].color}"]`).length).toBe(2);
  });
  it("navigates region searches and adds a candidate at the actual current centre", async () => {
    const location = { id: "suwon", label: "경기도 수원시", latitude: 37.2636, longitude: 127.0286,
      bbox: [126.9, 37.18, 127.12, 37.36], source: "local", kind: "region" };
    const fetch = mockApi();
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url) => url.includes("geocoding/search")
      ? response({ results: [location], provider: "local", warning: null, attribution: "지역명 사전" }) : fallback(url));
    const { map, onAddCandidate } = renderMap();
    const fly = vi.spyOn(map, "flyToBounds");
    fireEvent.change(screen.getByRole("textbox", { name: "지도 지역 검색" }), { target: { value: "수원시" } });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /경기도 수원시/ }));
    expect(fly).toHaveBeenCalledWith([[37.18, 126.9], [37.36, 127.12]], expect.objectContaining({ maxZoom: 13 }));
    fireEvent.click(screen.getByRole("button", { name: "현재 지도 중심에 후보지 추가" }));
    expect(onAddCandidate).toHaveBeenCalledWith({ latitude: map.getCenter().lat, longitude: map.getCenter().lng });
  });
  it("closes drawn polygons and saves longitude before latitude without identifying an object", async () => {
    const { map, onUpdate } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "후보 경계 그리기" }));
    act(() => {
      map.fire("click", { latlng: L.latLng(37.25, 127.01) });
      map.fire("click", { latlng: L.latLng(37.26, 127.02) });
      map.fire("click", { latlng: L.latLng(37.27, 127.01) });
    });
    fireEvent.click(screen.getByRole("button", { name: "경계 저장 (3)" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith({ geometry: { type: "Polygon", coordinates: [[[127.01, 37.25], [127.02, 37.26], [127.01, 37.27], [127.01, 37.25]]] },
      latitude: (37.25 + 37.26 + 37.27) / 3, longitude: (127.01 + 127.02 + 127.01) / 3 });
  });
  it("marks edited inputs stale without recreating or moving the viewport", () => {
    const { container, map, props, rerender } = renderMap();
    const center = map.getCenter();
    const edited = { ...candidate, cable_distance_m: 800 };
    rerender({ ...props, candidate: edited, candidates: [edited] });
    expect(container.querySelector(".site-pin")!.textContent).toContain("재분석 필요");
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    expect(container.querySelectorAll(`path[fill="${missingColor}"]`).length).toBe(2);
    expect(map.getCenter()).toEqual(center);
    expect(container.querySelectorAll(".leaflet-container").length).toBe(1);
  });
});
