import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as L from "leaflet";
import MapView from "../src/MapView";
import type { Candidate, Design, Result, Run } from "../src/types";
import { getMetricLegend, gradeInfo, missingColor } from "../src/mapData";

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
  it("inserts OSM tiles and selectable, correctly colored SVG candidate layers", async () => {
    const { container, onSelectCandidate } = renderMap();
    await waitFor(() => expect(container.querySelectorAll("img.leaflet-tile").length).toBeGreaterThan(0));
    expect((container.querySelector("img.leaflet-tile") as HTMLImageElement).src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    // Default view: feasibility grade with a ranked label pin on the site.
    expect(container.querySelectorAll(`path[fill="${gradeInfo.recommended.color}"]`).length).toBe(1);
    const pin = container.querySelector(".site-pin") as HTMLElement;
    expect(pin.textContent).toContain("1순위 · 추천");
    expect(pin.textContent).toContain("수원 수면 후보지");
    fireEvent.click(pin);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
    expect(screen.getByRole("button", { name: /수원 수면 후보지/ })).toBeTruthy();
    // Metric views still color the polygon and its circle marker by value bins.
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    const color = getMetricLegend("specific_yield")[3].color;
    const paths = container.querySelectorAll(`path[fill="${color}"]`);
    expect(paths.length).toBe(2); // Real polygon plus circle marker.
    onSelectCandidate.mockClear();
    fireEvent.click(paths[1]);
    expect(onSelectCandidate).toHaveBeenCalledWith("c1");
    expect((screen.getByRole("button", { name: "지도 확대" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("searches a region and moves the real viewport using west/south/east/north bounds", async () => {
    const location = { id: "suwon", label: "경기도 수원시", latitude: 37.2636, longitude: 127.0286, bbox: [126.9, 37.18, 127.12, 37.36], source: "local", kind: "region" };
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [location], provider: "local", warning: null, attribution: "지역명 사전" }) }));
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
    expect(container.querySelector(".site-pin")!.textContent).toContain("재분석 필요");
    expect(container.querySelectorAll(`path[fill="${gradeInfo.pending.color}"]`).length).toBe(1);
    fireEvent.change(screen.getByRole("combobox", { name: "지도 색상 지표" }), { target: { value: "specific_yield" } });
    expect(container.querySelectorAll(`path[fill="${missingColor}"]`).length).toBe(2);
    expect(map.getCenter()).toEqual(center);
    expect(container.querySelectorAll(".leaflet-container").length).toBe(1);
  });

  it("finds real water bodies in view and turns a picked one into a candidate", async () => {
    const reservoir = {
      id: "relation/1", name: "예당저수지", kind: "저수지", area_m2: 9275000, latitude: 36.6, longitude: 126.8,
      geometry: { type: "Polygon", coordinates: [[[126.78, 36.58], [126.82, 36.58], [126.82, 36.62], [126.78, 36.58]]] },
    };
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [reservoir], total: 1, attribution: "© OpenStreetMap", warning: null }) }));
    vi.stubGlobal("fetch", fetch);
    const onAddWater = vi.fn();
    const setView = vi.spyOn(L.Map.prototype, "setView");
    render(<MapView candidate={candidate} result={null} candidates={[candidate]} designs={[design]} runs={[run]}
      onSelectCandidate={vi.fn()} onAddCandidate={vi.fn()} onUpdate={vi.fn(async () => {})} onAddWater={onAddWater}/>);
    const map = setView.mock.contexts[0] as L.Map;
    fireEvent.click(screen.getByRole("button", { name: "이 지역 수면 찾기" }));
    fireEvent.click(await screen.findByRole("button", { name: /예당저수지/ }));
    const [url] = fetch.mock.calls[0] as unknown as [string];
    const query = new URL(url, "http://x").searchParams;
    const bounds = map.getBounds();
    expect(Number(query.get("west"))).toBeGreaterThanOrEqual(bounds.getWest() - 1e-4);
    expect(Number(query.get("east")) - Number(query.get("west"))).toBeLessThanOrEqual(0.8);
    // The candidate sits outside every mapped water body in the searched area.
    fireEvent.click(screen.getByRole("tab", { name: "사업성 순위" }));
    expect(screen.getByText("지도상 수면 밖에 있습니다")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "이 수면을 후보지로 추가" }));
    expect(onAddWater).toHaveBeenCalledWith(reservoir);
  });
});
