import type { FeatureCollection, Polygon as GeoJSONPolygon } from "geojson";
import type { Candidate, Design, MappedCandidate, Result, Run } from "./types";

export type MapMetric =
  | "grade"
  | "none"
  | "specific_yield"
  | "annual_kwh"
  | "bc"
  | "capacity_dc_kw";

export const metricDefinitions: Record<
  MapMetric,
  { label: string; unit: string; description: string }
> = {
  grade: {
    label: "사업성 등급",
    unit: "",
    description: "후보지별 가장 좋은 설계 대안의 B/C로 매긴 등급과 순위입니다.",
  },
  none: {
    label: "후보지 위치",
    unit: "",
    description: "저장한 후보지 경계를 표시합니다.",
  },
  specific_yield: {
    label: "용량당 발전량",
    unit: "kWh/kW·년",
    description: "후보지별 분석 결과의 설비 1 kW당 연간 발전량입니다.",
  },
  annual_kwh: {
    label: "연간 발전량",
    unit: "MWh/년",
    description:
      "후보지별 분석 결과의 연간 발전량이며 설비 규모에 영향을 받습니다.",
  },
  bc: {
    label: "B/C",
    unit: "배",
    description: "후보지별 분석 결과의 할인 편익 대비 비용 비율입니다.",
  },
  capacity_dc_kw: {
    label: "설비 용량",
    unit: "kW",
    description: "후보지별 분석 결과의 직류 정격 설비 용량입니다.",
  },
};

export type DistributionProperties = {
  id: string;
  name: string;
  design_name: string;
  metric_value: number | null;
  display_value: string;
  color: string;
  status: "completed" | "missing" | "stale";
  demo: boolean;
  run_id: string | null;
};

export const missingColor = "#94a3b8";
const locationColor = "#0f766e";
const greens = ["#d9f0d3", "#a6dba0", "#5aae91", "#006d5b"];
const blues = ["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"];
const economicColors = ["#dc6b62", "#e6b84c", "#5aae91", "#006d5b"];

type MetricBin = { threshold: number; label: string; color: string };
function metricBins(metric: Exclude<MapMetric, "none">): MetricBin[] {
  if (metric === "specific_yield") {
    return [
      { threshold: 1100, label: "1,100 미만", color: greens[0] },
      { threshold: 1300, label: "1,100–1,300", color: greens[1] },
      { threshold: 1500, label: "1,300–1,500", color: greens[2] },
      { threshold: Infinity, label: "1,500 이상", color: greens[3] },
    ];
  }
  if (metric === "bc") {
    return [
      { threshold: 1, label: "1.0 미만", color: economicColors[0] },
      { threshold: 1.2, label: "1.0–1.2", color: economicColors[1] },
      { threshold: 1.5, label: "1.2–1.5", color: economicColors[2] },
      { threshold: Infinity, label: "1.5 이상", color: economicColors[3] },
    ];
  }
  const scale = metric === "annual_kwh" ? 1000 : 1;
  return [
    { threshold: 500 * scale, label: "500 미만", color: blues[0] },
    { threshold: 1000 * scale, label: "500–1,000", color: blues[1] },
    { threshold: 2000 * scale, label: "1,000–2,000", color: blues[2] },
    { threshold: Infinity, label: "2,000 이상", color: blues[3] },
  ];
}

export function getMetricLegend(
  metric: MapMetric,
): { label: string; color: string }[] {
  if (metric === "grade")
    return (Object.keys(gradeInfo) as Grade[]).map((g) => ({
      label: `${gradeInfo[g].label} (${gradeInfo[g].rule})`,
      color: gradeInfo[g].color,
    }));
  if (metric === "none")
    return [{ label: "등록한 후보지", color: locationColor }];
  return [
    ...metricBins(metric).map(({ label, color }) => ({ label, color })),
    { label: "분석 전 · 재분석 필요", color: missingColor },
  ];
}

// JSON object order and server-maintained timestamps do not change an analysis input.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

export function candidateInputSignature(candidate: Candidate): string {
  return stableStringify({
    name: candidate.name,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    geometry: candidate.geometry,
    exclusions: candidate.exclusions,
    grid_point: candidate.grid_point,
    cable_distance_m: candidate.cable_distance_m,
    water_depth_m: candidate.water_depth_m,
    water_level_m: candidate.water_level_m,
    site_type: candidate.site_type,
    reference_plant_id: candidate.reference_plant_id,
  });
}

export function designInputSignature(design: Design): string {
  return stableStringify({
    candidate_id: design.candidate_id,
    name: design.name,
    equipment: design.equipment,
    costs: design.costs,
    finance: design.finance,
  });
}

function newestFirst(a: Run, b: Run): number {
  const aTime = Date.parse(a.created_at);
  const bTime = Date.parse(b.created_at);
  const difference =
    (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  return (
    difference ||
    b.created_at.localeCompare(a.created_at) ||
    b.id.localeCompare(a.id)
  );
}

function metricValue(run: Run, metric: MapMetric): number | null {
  if (!run.result || metric === "none" || metric === "grade") return null;
  const value = metric === "bc" ? run.result.economics.bc : run.result[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMetric(value: number, metric: MapMetric): string {
  const display = metric === "annual_kwh" ? value / 1000 : value;
  return `${new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: metric === "bc" ? 2 : 1,
  }).format(display)} ${metricDefinitions[metric].unit}`;
}

/** Saved candidate analysis results, never an interpolated nationwide potential map. */
export function buildDistribution(
  candidates: MappedCandidate[],
  designs: Design[],
  runs: Run[],
  metric: MapMetric,
  preferredDesignId?: string,
): FeatureCollection<GeoJSONPolygon, DistributionProperties> {
  return {
    type: "FeatureCollection",
    features: candidates.map((candidate) => {
      const candidateDesigns = designs.filter(
        (design) =>
          design.candidate_id === candidate.id &&
          design.project_id === candidate.project_id,
      );
      const preferred = candidateDesigns.find(
        (design) => design.id === preferredDesignId,
      );
      const eligibleDesigns = preferred ? [preferred] : candidateDesigns;
      const run = runs
        .filter(
          (entry) =>
            entry.status === "completed" &&
            entry.project_id === candidate.project_id &&
            eligibleDesigns.some((design) => design.id === entry.design_id),
        )
        .sort(newestFirst)[0];
      const design = run
        ? eligibleDesigns.find((entry) => entry.id === run.design_id)
        : preferred;
      const stale = Boolean(
        run &&
          design &&
          (!run.snapshot?.candidate ||
            !run.snapshot?.design ||
            candidateInputSignature(candidate) !==
              candidateInputSignature(run.snapshot.candidate) ||
            designInputSignature(design) !==
              designInputSignature(run.snapshot.design)),
      );
      const value = run ? metricValue(run, metric) : null;
      const status: DistributionProperties["status"] = stale
        ? "stale"
        : run?.result && (metric === "none" || value !== null)
          ? "completed"
          : "missing";
      const color =
        metric === "none"
          ? locationColor
          : status !== "completed" || value === null || metric === "grade"
            ? missingColor
            : metricBins(metric).find((bin) => value < bin.threshold)!.color;
      return {
        type: "Feature",
        id: candidate.id,
        geometry: candidate.geometry,
        properties: {
          id: candidate.id,
          name: candidate.name,
          design_name: design?.name || "",
          metric_value: status === "completed" ? value : null,
          display_value:
            metric === "none"
              ? "후보지 위치"
              : status === "stale"
                ? "입력 변경 · 재분석 필요"
                : status === "missing"
                  ? run?.result
                    ? "결과 값 없음"
                    : "분석 결과 없음"
                  : formatMetric(value!, metric),
          color,
          status,
          demo: Boolean(run?.snapshot?.project?.demo),
          run_id: run?.id || null,
        },
      };
    }),
  };
}

export function candidateBounds(
  candidates: MappedCandidate[],
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const candidate of candidates) {
    for (const coordinate of candidate.geometry.coordinates[0] || []) {
      const [longitude, latitude] = coordinate;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

export type Grade = "recommended" | "review" | "weak" | "pending";
/** Screening thresholds for a pre-feasibility review; not an investment decision. */
export const gradeInfo: Record<
  Grade,
  { label: string; rule: string; color: string; soft: string }
> = {
  recommended: {
    label: "추천",
    rule: "B/C 1.2 이상",
    color: "#15803d",
    soft: "#dcfce7",
  },
  review: {
    label: "검토",
    rule: "B/C 1.0–1.2",
    color: "#c2410c",
    soft: "#ffedd5",
  },
  weak: {
    label: "비추천",
    rule: "B/C 1.0 미만",
    color: "#b91c1c",
    soft: "#fee2e2",
  },
  pending: {
    label: "분석 전",
    rule: "결과 없음",
    color: "#64748b",
    soft: "#f1f5f9",
  },
};
export function gradeOf(result: Result | null | undefined): Grade {
  if (!result) return "pending";
  const { bc, npv } = result.economics;
  if (bc == null) return "review";
  if (bc >= 1.2 && npv > 0) return "recommended";
  return bc >= 1 ? "review" : "weak";
}

export type SiteRanking = {
  candidate: MappedCandidate;
  design: Design | null;
  run: Run | null;
  grade: Grade;
  /** 1 is the best analysed site; null until a current result exists. */
  rank: number | null;
  stale: boolean;
};
/** Rank saved sites by their best current design (highest B/C, then NPV). */
export function rankCandidates(
  candidates: MappedCandidate[],
  designs: Design[],
  runs: Run[],
): SiteRanking[] {
  const rows = candidates.map((candidate) => {
    let best: { design: Design; run: Run } | null = null;
    let stale = false;
    for (const design of designs) {
      if (
        design.candidate_id !== candidate.id ||
        design.project_id !== candidate.project_id
      )
        continue;
      const run = runs
        .filter(
          (r) =>
            r.status === "completed" && r.result && r.design_id === design.id,
        )
        .sort(newestFirst)[0];
      if (!run) continue;
      if (
        !run.snapshot?.candidate ||
        !run.snapshot?.design ||
        candidateInputSignature(candidate) !==
          candidateInputSignature(run.snapshot.candidate) ||
        designInputSignature(design) !==
          designInputSignature(run.snapshot.design)
      ) {
        stale = true;
        continue;
      }
      if (!best || compareRuns(run, best.run) < 0) best = { design, run };
    }
    return {
      candidate,
      design: best?.design || null,
      run: best?.run || null,
      grade: gradeOf(best?.run.result),
      rank: null as number | null,
      stale: !best && stale,
    };
  });
  const analysed = rows
    .filter((r) => r.run)
    .sort((a, b) => compareRuns(a.run!, b.run!));
  analysed.forEach((r, i) => (r.rank = i + 1));
  return [...analysed, ...rows.filter((r) => !r.run)];
}
function compareRuns(a: Run, b: Run): number {
  const ea = a.result!.economics,
    eb = b.result!.economics;
  return (eb.bc ?? -Infinity) - (ea.bc ?? -Infinity) || eb.npv - ea.npv;
}
