import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SiteSolar from "../src/SiteSolar";
import type { Candidate } from "../src/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const candidate = { id: "candidate", project_id: "p", name: "existing", latitude: 36.8, longitude: 127,
  geometry: null, site_type: "building", reference_plant_id: "plant" } as Candidate;
const props = { site: null, point: candidate, siteType: "building" as const, candidate };
const response = (value: unknown) => new Response(JSON.stringify(value));

it("switches from site potential to recorded operating data without copying the forecast", async () => {
  const fetch = vi.fn(async (url: string) => response(url.endsWith("/solar-potential")
    ? { status: "available", capacity_dc_kw: 900, annual_kwh: 1240000, module_count: 2000,
      specific_yield: 1377, references: [], notice: "면적 기반", capacity_basis: "경계 내 면적" }
    : { scope_label: "선택 후보지에 연결된 기존 시설", notice: "기록된 실적", facilities: [
      { id: "plant", name: "운영 중 시설", source: "K-water", capacity_kw: 42,
        series: [{ id: "s", label: "전력거래량", years: [{ year: 2026, recorded_kwh: 17000,
          observed_periods: 31, expected_periods: 365, resolution: "daily", complete: false, start: "2026-01-01", end: "2026-01-31" }] }] }] }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<SiteSolar {...props} tab="potential" />);
  expect(await screen.findByText("1,240.0")).toBeTruthy();
  view.rerender(<SiteSolar {...props} tab="generation" />);
  expect(await screen.findByText("17.0 MWh")).toBeTruthy();
  expect(screen.getByText("42.0")).toBeTruthy();
  expect(screen.getByText("전력거래량")).toBeTruthy();
  expect(screen.getByRole("cell", { name: /부분 기간/ })).toBeTruthy();
  expect(screen.queryByText("1,240.0")).toBeNull();
  expect(screen.queryByText("잠재 연간 발전량")).toBeNull();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/solar-potential", "/api/solar-status"]);
});

it("leaves generation unregistered instead of substituting a prediction or zero", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ scope_label: "선택 경계", facilities: [], notice: "등록 자료 범위" })));
  render(<SiteSolar {...props} tab="generation" />);
  expect(await screen.findByText(/기존 태양광 시설 자료가 없습니다/)).toBeTruthy();
  expect(screen.queryByText("연간 예상 발전량")).toBeNull();
  expect(screen.queryByText("0.0 MWh")).toBeNull();
});
