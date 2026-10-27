import { describe, expect, it } from "vitest";
import { gradeOf, rankCandidates } from "../src/mapData";
import type { Candidate, Design, Result, Run } from "../src/types";

const site = (id: string): Candidate => ({
  id, project_id: "p1", name: `후보지 ${id}`, latitude: 36, longitude: 127,
  geometry: { type: "Polygon", coordinates: [[[127, 36], [127.01, 36], [127.01, 36.01], [127, 36]]] },
  exclusions: [], grid_point: null, cable_distance_m: null, water_depth_m: null, water_level_m: null,
});
const design = (id: string, candidate_id: string): Design => ({
  id, project_id: "p1", candidate_id, name: `대안 ${id}`,
  equipment: {}, costs: {}, finance: {}, sensitivity: {},
});
const result = (bc: number | null, npv: number) => ({ economics: { bc, npv } }) as Result;
const run = (id: string, c: Candidate, d: Design, bc: number | null, npv: number, created_at = "2026-01-01T00:00:00Z"): Run => ({
  id, design_id: d.id, project_id: "p1", status: "completed", created_at, error: null,
  snapshot: { candidate: structuredClone(c), design: structuredClone(d), project: { id: "p1", name: "", description: "", demo: true } },
  result: result(bc, npv),
});

describe("feasibility grade", () => {
  it("applies the screening thresholds", () => {
    expect(gradeOf(null)).toBe("pending");
    expect(gradeOf(result(1.2, 1))).toBe("recommended");
    expect(gradeOf(result(1.5, -1))).toBe("review");
    expect(gradeOf(result(1.0, 0))).toBe("review");
    expect(gradeOf(result(0.99, -5))).toBe("weak");
    expect(gradeOf(result(null, 0))).toBe("review");
  });
});

describe("site ranking", () => {
  it("ranks each site by its best current design and keeps unanalysed sites last", () => {
    const a = site("a"), b = site("b"), c = site("c");
    const a1 = design("a1", "a"), a2 = design("a2", "a"), b1 = design("b1", "b"), c1 = design("c1", "c");
    const rows = rankCandidates([a, b, c], [a1, a2, b1, c1], [
      run("ra1", a, a1, 0.9, -1),
      run("ra2", a, a2, 1.1, 1),
      run("rb1", b, b1, 1.6, 9),
    ]);
    expect(rows.map((r) => [r.candidate.id, r.rank, r.grade, r.design?.id])).toEqual([
      ["b", 1, "recommended", "b1"],
      ["a", 2, "review", "a2"],
      ["c", null, "pending", undefined],
    ]);
  });

  it("does not grade a site whose inputs changed after the analysis", () => {
    const a = site("a"), a1 = design("a1", "a");
    const edited = { ...a, cable_distance_m: 500 };
    const [row] = rankCandidates([edited], [a1], [run("r", a, a1, 2, 9)]);
    expect(row).toMatchObject({ grade: "pending", rank: null, stale: true });
  });
});
