import { describe, expect, it } from "vitest";
import {
  buildDistribution,
  candidateBounds,
  candidateInputSignature,
  designInputSignature,
  getMetricLegend,
  missingColor,
} from "../src/mapData";
import type { Candidate, Design, Result, Run } from "../src/types";

const candidate: Candidate = {
  id: "c1",
  project_id: "p1",
  name: "수원 후보지",
  latitude: 37.25,
  longitude: 127,
  geometry: {
    type: "Polygon",
    coordinates: [[[126.99, 37.24], [127.02, 37.24], [127.02, 37.27], [126.99, 37.24]]],
  },
  exclusions: [],
  grid_point: null,
  cable_distance_m: null,
  water_depth_m: null,
  water_level_m: null,
};
const design: Design = {
  id: "d1",
  project_id: "p1",
  candidate_id: "c1",
  name: "기본안",
  updated_at: "2026-01-01T00:00:00Z",
  equipment: { module_count: 1000, module_power_w: 550 },
  costs: { module_per_kw: 300000 },
  finance: { discount_pct: 4.5, stress_pcts: [5, 10] },
};
function makeRun(overrides: Partial<Run> = {}, result: Partial<Result> = {}): Run {
  return {
    id: "r1",
    design_id: "d1",
    project_id: "p1",
    status: "completed",
    created_at: "2026-01-01T00:00:00Z",
    snapshot: {
      project: { id: "p1", name: "예시 프로젝트", description: "", demo: true },
      candidate: structuredClone(candidate),
      design: structuredClone(design),
    },
    result: {
      annual_kwh: 800000,
      specific_yield: 1300,
      capacity_dc_kw: 550,
      economics: { bc: 1.25 },
      ...result,
    } as Result,
    error: null,
    ...overrides,
  };
}

describe("saved analysis distribution", () => {
  it("does not fabricate values for candidates without a completed analysis", () => {
    const pending = makeRun({ status: "running" });
    const feature = buildDistribution([candidate], [design], [pending], "annual_kwh").features[0];
    expect(feature.properties).toMatchObject({
      status: "missing", metric_value: null, color: missingColor, run_id: null,
      display_value: "분석 결과 없음", demo: false,
    });
  });

  it("uses the newest completed analysis and converts kWh to MWh for display only", () => {
    const older = makeRun({ id: "older", created_at: "2025-01-01T00:00:00Z" });
    const newer = makeRun({ id: "newer", created_at: "2026-01-01T00:00:00Z" }, { annual_kwh: 1250000 });
    const pending = makeRun({ id: "pending", created_at: "2027-01-01T00:00:00Z", status: "pending" });
    const properties = buildDistribution([candidate], [design], [pending, older, newer], "annual_kwh").features[0].properties;
    expect(properties).toMatchObject({
      run_id: "newer", metric_value: 1250000, display_value: "1,250 MWh/년",
      status: "completed", demo: true,
    });
    expect(properties.color).toBe(getMetricLegend("annual_kwh")[2].color);
  });

  it("honors a preferred design even when another design has a newer analysis", () => {
    const alternative: Design = { ...structuredClone(design), id: "d2", name: "대안" };
    const alternateRun = makeRun({
      id: "r2", design_id: "d2", created_at: "2027-01-01T00:00:00Z",
      snapshot: { ...makeRun().snapshot, design: alternative },
    });
    const preferred = buildDistribution([candidate], [design, alternative], [makeRun(), alternateRun], "bc", "d1");
    expect(preferred.features[0].properties.run_id).toBe("r1");
    const latest = buildDistribution([candidate], [design, alternative], [makeRun(), alternateRun], "bc", "other-candidate-design");
    expect(latest.features[0].properties.run_id).toBe("r2");
    const uncomputed = buildDistribution([candidate], [design, alternative], [alternateRun], "bc", "d1");
    expect(uncomputed.features[0].properties).toMatchObject({ status: "missing", run_id: null, design_name: "기본안" });
  });

  it("marks changed physical, financial and stress-test inputs stale instead of painting old results", () => {
    const editedCandidate = { ...candidate, cable_distance_m: 900 };
    const editedDesign = { ...design, finance: { ...design.finance, discount_pct: 6 } };
    for (const [currentCandidate, currentDesign] of [
      [editedCandidate, design],
      [candidate, editedDesign],
      [candidate, { ...design, finance: { ...design.finance, stress_pcts: [20] } }],
      [{ ...candidate, site_type: "plant" } as Candidate, design],
    ] as [Candidate, Design][]) {
      const properties = buildDistribution([currentCandidate], [currentDesign], [makeRun()], "bc").features[0].properties;
      expect(properties).toMatchObject({ status: "stale", metric_value: null, color: missingColor, run_id: "r1" });
    }
  });

  it("ignores server timestamps and object key order when checking input snapshots", () => {
    const reordered = {
      ...design,
      updated_at: "2028-01-01T00:00:00Z",
      equipment: { module_power_w: 550, module_count: 1000 },
    };
    expect(designInputSignature(reordered)).toBe(designInputSignature(design));
    expect(candidateInputSignature({ ...candidate, geometry: { coordinates: candidate.geometry.coordinates, type: "Polygon" } }))
      .toBe(candidateInputSignature(candidate));
    expect(buildDistribution([candidate], [reordered], [makeRun()], "bc").features[0].properties.status).toBe("completed");
  });

  it("keeps null B/C and null results gray instead of treating them as zero", () => {
    const missingBC = makeRun({}, { economics: { bc: null } as Result["economics"] });
    const properties = buildDistribution([candidate], [design], [missingBC], "bc").features[0].properties;
    expect(properties).toMatchObject({ status: "missing", metric_value: null, color: missingColor, display_value: "결과 값 없음" });
    const nullResult = buildDistribution([candidate], [design], [makeRun({ result: null })], "bc").features[0].properties;
    expect(nullResult).toMatchObject({ status: "missing", metric_value: null, color: missingColor });
  });

  it.each([
    ["specific_yield", 1099, 0], ["specific_yield", 1100, 1],
    ["specific_yield", 1300, 2], ["specific_yield", 1500, 3],
    ["annual_kwh", 499999, 0], ["annual_kwh", 500000, 1],
    ["annual_kwh", 1000000, 2], ["annual_kwh", 2000000, 3],
    ["capacity_dc_kw", 499, 0], ["capacity_dc_kw", 500, 1],
    ["capacity_dc_kw", 1000, 2], ["capacity_dc_kw", 2000, 3],
    ["bc", 0.99, 0], ["bc", 1, 1], ["bc", 1.2, 2], ["bc", 1.5, 3],
  ] as const)("uses fixed %s thresholds at %s", (metric, value, bin) => {
    const result: Partial<Result> = metric === "bc"
      ? { economics: { bc: value } as Result["economics"] }
      : { [metric]: value };
    const properties = buildDistribution([candidate], [design], [makeRun({}, result)], metric).features[0].properties;
    expect(properties.color).toBe(getMetricLegend(metric)[bin].color);
    expect(properties.metric_value).toBe(value);
  });

  it("shows candidate geometry in location mode without implying an analysis exists", () => {
    const feature = buildDistribution([candidate], [design], [], "none").features[0];
    expect(feature.geometry).toEqual(candidate.geometry);
    expect(feature.properties).toMatchObject({ status: "missing", metric_value: null, display_value: "후보지 위치" });
    expect(feature.properties.color).toBe(getMetricLegend("none")[0].color);
  });
});

describe("candidate map bounds", () => {
  it("includes all outer vertices instead of only the candidate center", () => {
    const second = { ...candidate, id: "c2", geometry: { type: "Polygon" as const, coordinates: [[[129, 35], [129.1, 35.1], [129, 35]]] } };
    expect(candidateBounds([candidate, second])).toEqual([126.99, 35, 129.1, 37.27]);
    expect(candidateBounds([])).toBeNull();
  });
});
