// UI state integration tests use an isolated in-memory API fixture.
// Physics and finance are independently verified against the real Python engine.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import { CandidateForm } from "../src/Editors";
import type { Candidate, Design, Run } from "../src/types";
vi.mock("../src/MapView", () => ({
  default: () => <div data-testid="map">좌표 편집 지도</div>,
}));
vi.mock("recharts", () =>
  Object.fromEntries(
    [
      "Bar",
      "BarChart",
      "ComposedChart",
      "ErrorBar",
      "CartesianGrid",
      "Legend",
      "Line",
      "LineChart",
      "ReferenceLine",
      "ResponsiveContainer",
      "Tooltip",
      "XAxis",
      "YAxis",
    ].map((name) => [
      name,
      ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    ]),
  ),
);
const original: Candidate = {
  id: "c1",
  project_id: "p1",
  name: "테스트 수면",
  latitude: 36.5,
  longitude: 127,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [126.99, 36.49],
        [127.01, 36.49],
        [127.01, 36.51],
        [126.99, 36.51],
        [126.99, 36.49],
      ],
    ],
  },
  exclusions: [
    {
      type: "Polygon",
      coordinates: [
        [
          [127, 36.5],
          [127.001, 36.5],
          [127.001, 36.501],
          [127, 36.5],
        ],
      ],
    },
  ],
  grid_point: null,
  cable_distance_m: null,
  water_depth_m: null,
  water_level_m: null,
  site_type: "floating",
  reference_plant_id: null,
  source: "테스트 경계",
};
const initial: Design = {
  id: "d1",
  project_id: "p1",
  candidate_id: "c1",
  name: "검토 기본안",
  updated_at: "0",
  equipment: {
    structure_type: "fixed",
    tilt_mode: "guideline",
    tilt: 30,
    azimuth: 180,
    purpose: "sale",
    module_preset: "floating_450",
    module_model: "수상용 단결정 450 Wp",
    module_power_w: 450,
    module_width_m: 1.03,
    module_height_m: 2.171,
    module_price: 225000,
    vmp_v: 44.81,
    voc_v: 53.61,
    voltage_temp_coeff_pct: -0.27,
    capacity_mode: "count",
    module_count: 1200,
    area_use_pct: 10,
    array_rows: 1,
    spacing_mode: "guideline",
    row_spacing_m: 1.2,
    inverter_configuration: "auto",
    energy_basis: "calibrated",
    system_loss_pct: 14,
    inverter_efficiency: 0.96,
    gamma_pdc: -0.0035,
  },
  costs: {
    float_per_kw: 300000,
    mooring_per_kw: 160000,
    structure_per_kw: 0,
    electrical_per_kw: 180000,
    junction_box_unit: 0,
    cable_per_m: 120000,
    civil: 70000000,
    design_permitting: 50000000,
    grid_connection: 60000000,
    annual_om_per_kw: 27000,
    replacement_year: 12,
  },
  finance: {
    years: 20,
    discount_pct: 4.5,
    degradation_pct: 0.5,
    sale_mode: "fixed",
    fixed_price: 150,
    smp_price: 100,
    rec_price: 60000,
    rec_weight: 1,
    curtailment_pct: 0,
    self_use_kwh: 0,
    retail_price: 0,
    stress_pcts: [5, 10],
  },
};
function fixtureResult(d: Design) {
  const dc = Number(d.equipment.module_count) * 0.55;
  return {
    capacity_dc_kw: dc,
    capacity_ac_kw: 600,
    annual_kwh: 120000,
    specific_yield: 181.8,
    capacity_factor_pct: 13.5,
    daily_hours: 3.2,
    energy_basis: "calibrated" as const,
    monthly: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      energy_kwh: 10000,
      physics_kwh: 11000,
      calibrated_kwh: 10000,
      p10_kwh: 9000,
      p90_kwh: 11000,
      ratio: 0.91,
      poa_kwh_m2: 150,
      ghi_kwh_m2: 120,
      temp_air: 12,
    })),
    physics: {
      annual_kwh: 132000,
      years: [2016, 2025],
      annual_by_year: [{ year: 2016, energy_kwh: 132000 }],
    },
    calibration: {
      model: "gbr_floating",
      model_label: "GBR + 수상 발전소 잔차 보정 (2단계)",
      annual_kwh: 120000,
      annual_p10_kwh: 108000,
      annual_p90_kwh: 131000,
      annual_by_year: [{ year: 2016, energy_kwh: 120000 }],
      band_basis: "장소 분리 검증 분포",
      band_plants: 26,
      excluded_plant: null,
      validation: {
        label: "GBR",
        all: { months: 1, plants: 1, mape_pct: 10, bias_pct: 2, rmse_pct: 12, plant_total_abs_error_pct: 4 },
        floating: null,
      },
    },
    steps: {
      site: {
        province: "충청남도",
        nearest_city: "아산시",
        region_basis: "내장 시·군 중심점",
        optimal_tilt: 30,
        tilt_basis: "표 3-19",
        seasonal_tilts: { spring: 27, summer: 10, autumn: 27, winter: 33 },
        seasonal_basis: "표 3-21",
        azimuth_basis: "3.5.1",
        wind_speed_ms: 40,
        snow_load_kn_m2: 0.5,
        seismic_zone: "Ⅰ",
        seismic_coeff_g: 0.14,
        structural_basis: "표 3-4",
        site_type: "floating" as const,
        structure_type: "fixed" as const,
        tilt: 30,
        azimuth: 180,
        tilt_mode: "guideline",
      },
      equipment: {
        module: {
          module_model: "수상용 단결정 450 Wp",
          module_power_w: 450,
          module_width_m: 1.03,
          module_height_m: 2.171,
          module_price: 225000,
        },
        area_m2: 100000,
        usable_area_m2: 90000,
        max_modules_by_area: 18000,
        requested_modules: Number(d.equipment.module_count),
        module_count: Number(d.equipment.module_count),
        pitch: { array_length_m: 2.171, plan_depth_m: 1.88, gap_m: 2.56, pitch_m: 4.44, basis: "표 3-22" },
        strings: {
          series: 15,
          parallel: Math.floor(Number(d.equipment.module_count) / 15),
          series_min: 14,
          series_max: 16,
          string_voc_v: 804,
          basis: "표 3-13",
          warnings: [],
        },
        inverter: {
          units: [{ kw: 500, count: 1, unit_cost: 40000000 }],
          ac_capacity_kw: 600,
          cost: 55000000,
          rule: "멀티구성 원칙",
          junction_boxes: [{ inverter_kw: 500, channels: 20, count: 4 }],
          junction_box_count: 4,
          basis: "표 3-12",
        },
        grid: { voltage: "특고압 3상 22.9 kV", network: "한전 배전선로", voltage_variation_limit_pct: 3 },
        purpose: "sale" as const,
      },
      costs: {
        items: [{ key: "module", label: "태양광 모듈", amount: 100000000, basis: "수량 × 단가", source: "가이드라인 표 3-9" }],
        total: 100000000,
        per_kw: 150000,
        annual_om: 1000000,
        replacement_cost: 55000000,
        replacement_year: 12,
      },
      revenue: {
        purpose: "sale" as const,
        price_per_kwh: 150,
        first_year_revenue: 18000000,
        first_year_sales_kwh: 120000,
        first_year_self_use_kwh: 0,
      },
      substitution: { households: 27.6, oil_toe: 30, pine_trees: 8478, co2_t: 56.4, basis: "부록 2.7" },
    },
    economics: {
      capex: 100000000,
      annual_opex: 1000000,
      first_year_sales_kwh: 120000,
      first_year_revenue: 18000000,
      pv_inflow: 130000000,
      pv_outflow: 100000000,
      npv: 30000000,
      bc: 1.3,
      irr_pct: 8,
      payback_years: 5,
      effective_price_per_kwh: 150,
      required_price_per_kwh: 115.4,
      cashflows: [],
    },
    stress: [
      { label: "검증 하한 P10", factor: 0.9, annual_kwh: 108000, bc: null, npv: 0, irr_pct: null, required_price_per_kwh: 128 },
    ],
    layout: {
      module_count: 1200,
      requested_count: 1200,
      area_m2: 100000,
      usable_area_m2: 90000,
      coverage_pct: 3,
      modules: [],
      warnings: [],
    },
    cable_distance_m: 0,
    connection_distance_basis: "연결점 미입력",
    provenance: {
      model: "UI fixture only",
      version: "test",
      weather_source: "UI 테스트 고정값",
      period: { start: "2025-01-01T00:00:00+09:00", end: "2026-01-01T00:00:00+09:00" },
      interval_minutes: 60,
      assumptions: [],
      warnings: [],
    },
  };
}
let designs: Design[], runs: Run[], clock: number;
beforeEach(() => {
  localStorage.clear();
  clock = 0;
  designs = [structuredClone(initial)];
  runs = [];
  const project = {
    id: "p1",
    name: "통합 테스트 프로젝트",
    description: "",
    demo: true,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace("/api", "");
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      let value: unknown;
      if (path === "/projects")
        value = [
          project,
          {
            id: "p2",
            name: "비어 있는 새 프로젝트",
            description: "",
            demo: false,
          },
        ];
      else if (path === "/health") value = { storage: "local" };
      else if (path === "/catalogs") value = { defaults: initial, modules: [], guideline: "test" };
      else if (path === "/projects/p2/workspace")
        value = {
          project: {
            id: "p2",
            name: "비어 있는 새 프로젝트",
            description: "",
            demo: false,
          },
          candidates: [],
          designs: [],
          runs: [],
        };
      else if (path.endsWith("/workspace"))
        value = { project, candidates: [original], designs, runs };
      else if (path.endsWith("/duplicate")) {
        const source = designs.find((d) => path.includes(d.id))!;
        const d = {
          ...structuredClone(source),
          id: "d2",
          name: "복제안",
          updated_at: String(++clock),
        };
        designs.push(d);
        value = d;
      } else if (method === "PATCH" && path.startsWith("/designs/")) {
        const d = designs.find((d) => path.includes(d.id))!;
        Object.assign(d, body, { updated_at: String(++clock) });
        value = d;
      } else if (method === "POST" && path.endsWith("/runs")) {
        const d = designs.find((d) => path.includes(d.id))!;
        const r: Run = {
          id: "r" + ++clock,
          design_id: d.id,
          project_id: "p1",
          created_at: new Date(2025, 0, 1, 0, clock).toISOString(),
          status: "completed",
          error: null,
          snapshot: {
            project,
            candidate: structuredClone(original),
            design: structuredClone(d),
          },
          result: fixtureResult(d),
        };
        runs.push(r);
        value = r;
      } else if (path.startsWith("/runs/"))
        value = runs.find((r) => path.endsWith(r.id));
      else throw new Error("Unhandled fixture request " + method + " " + path);
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("candidate data integrity", () => {
  it("saves unknown optional survey data as null without requiring invented values", async () => {
    const save = vi.fn();
    render(<CandidateForm candidate={original} onSubmit={save} />);
    const form = screen
      .getByRole("button", { name: "후보지 저장" })
      .closest("form")!;
    expect(form.checkValidity()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "후보지 저장" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        water_depth_m: null,
        water_level_m: null,
        cable_distance_m: null,
      }),
    );
  });
  it("moves exclusion geometry together with a manual coordinate change", () => {
    const save = vi.fn();
    render(<CandidateForm candidate={original} onSubmit={save} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "경도" }), {
      target: { value: "127.1" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "후보지 저장" }).closest("form")!,
    );
    const value = save.mock.calls[0][0] as Candidate;
    expect(value.geometry!.coordinates[0][0][0]).toBeCloseTo(127.09);
    expect(value.exclusions[0].coordinates[0][0][0]).toBeCloseTo(127.1);
  });
});
it("keeps saved analysis metrics together and warns when the draft changes", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("combobox", { name: "후보지 선택" });
  await user.click(
    screen.getByRole("button", { name: "분석 실행", exact: true }),
  );
  await screen.findByText("분석 완료");
  // The step board opens on ③ and switches to one step at a time.
  expect(screen.getByRole("heading", { name: "③ 설치용량 및 연간발전량" })).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: /재무성/ }));
  expect(screen.getByRole("heading", { name: "⑥ 재무성 분석 및 에너지 대체효과" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "③ 설치용량 및 연간발전량" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "설계 조건" }));
  await user.click(screen.getByRole("tab", { name: "② 기자재" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "모듈 수량" }), {
    target: { value: "1000" },
  });
  await screen.findByText(/현재 조건이 분석 시점과 다릅니다/);
  const cards = document.querySelectorAll(".stat");
  expect(cards[0].textContent).toContain("660.0");
  expect(cards[3].textContent).toContain("115.4");
  expect(screen.getByRole("button", { name: "조건 저장" })).toBeTruthy();
});
it("resets validation run selection when switching to another project", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("combobox", { name: "후보지 선택" });
  await user.click(
    screen.getByRole("button", { name: "분석 실행", exact: true }),
  );
  await screen.findByText("분석 완료");
  await user.click(
    screen.getByRole("button", { name: "실적 CSV 대조", exact: true }),
  );
  await screen.findByText("02. 계량·검증 조건");
  expect(
    (screen.getByLabelText("비교할 분석 실행") as HTMLSelectElement).value,
  ).toBe(runs[0].id);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "프로젝트 선택" }),
    "p2",
  );
  await screen.findByText("분석을 먼저 실행하세요");
  expect(
    (screen.getByLabelText("비교할 분석 실행") as HTMLSelectElement).value,
  ).toBe("");
});
it("runs, duplicates, saves changed equipment, compares snapshots and opens a printable report", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("combobox", { name: "후보지 선택" });
  await user.click(
    screen.getByRole("button", { name: "분석 실행", exact: true }),
  );
  await screen.findByText("분석 완료");
  await user.click(screen.getByText("관리"));
  await user.click(screen.getByRole("button", { name: "대안 복제", exact: true }));
  await user.click(screen.getByRole("tab", { name: "설계 조건" }));
  await waitFor(() => expect(designs.length).toBe(2));
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "대안 이름" }) as HTMLInputElement)
        .value,
    ).toBe("복제안"),
  );
  await user.click(screen.getByRole("tab", { name: "② 기자재" }));
  const count = screen.getByRole("spinbutton", { name: "모듈 수량" });
  await user.clear(count);
  await user.type(count, "500");
  await user.click(
    screen.getByRole("button", { name: "조건 저장", exact: true }),
  );
  await waitFor(() => expect(designs[1].equipment.module_count).toBe(500));
  await user.click(
    screen.getByRole("button", { name: "분석 실행", exact: true }),
  );
  await waitFor(() => expect(runs.length).toBe(2));
  await screen.findByText("분석 완료");
  await user.click(
    screen.getByRole("button", { name: "후보지 비교", exact: true }),
  );
  await screen.findByRole("heading", { name: "후보지·대안 비교" });
  expect(screen.getAllByText("복제안").length).toBeGreaterThan(0);
  await user.click(
    screen.getByRole("button", { name: "검토 보고서", exact: true }),
  );
  await screen.findByRole("button", { name: "인쇄 · PDF 저장" });
  const report = document.querySelector("article")!;
  expect(within(report).getByText(/450 W × 500장/)).toBeTruthy();
  expect(within(report).getByRole("heading", { name: /가이드라인 6단계 요약/ })).toBeTruthy();
  expect(within(report).getByText(/15직렬 × 33병렬 = 500장/)).toBeTruthy();
  expect(within(report).getByText(/2025-01-01 ~ 2026-01-01/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "인쇄 · PDF 저장" })).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "사업성 검토", exact: true }),
  );
  await user.click(screen.getByRole("tab", { name: "결과" }));
  await user.click(screen.getByRole("tab", { name: /재무성/ }));
  expect((await screen.findAllByText("산정 불가")).length).toBeGreaterThan(0);
});
