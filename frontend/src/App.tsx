import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ChartLine,
  CircleHelp,
  ClipboardCheck,
  CloudSun,
  Database,
  FileText,
  FileUp,
  GitCompareArrows,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, date, download, num } from "./api";
import type {
  Candidate,
  Catalog,
  Design,
  Plant,
  Project,
  Run,
  SiteType,
  WaterBody,
  Workspace,
} from "./types";
import Wizard from "./Wizard";
import { hasGeometry } from "./types";
import MapView from "./MapLoader";
import { CandidateForm } from "./Editors";
import {
  candidateInputSignature,
  designInputSignature,
  gradeInfo,
  gradeOf,
} from "./mapData";
import Validation from "./Validation";
import { ModelValidation, PlantRecords, WeatherValidation } from "./Records";
import { GLOSSARY } from "./Steps";
import ReportBody from "./Report";

type Page = "review" | "data" | "weather" | "model" | "compare" | "validation" | "report";
type Modal =
  | { kind: "project"; project?: Project }
  | { kind: "candidate"; candidate: Candidate; isNew?: boolean }
  | { kind: "help" }
  | null;
const colors = ["#2563eb", "#0d9488", "#d97706", "#7c3aed", "#db2777"];
const icons: Record<Page, LucideIcon> = {
  review: ClipboardCheck,
  compare: GitCompareArrows,
  report: FileText,
  data: Database,
  weather: CloudSun,
  model: ChartLine,
  validation: FileUp,
};
const compareKey = (projectId: string) => `solar-compare-${projectId}`;
function readRegistered(projectId: string): string[] | null {
  try {
    const raw = localStorage.getItem(compareKey(projectId));
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}
function writeRegistered(projectId: string, ids: string[]) {
  try {
    localStorage.setItem(compareKey(projectId), JSON.stringify(ids));
  } catch {
    /* storage unavailable: the list lives for this visit only */
  }
}
const pages: {
  id: Page;
  group: "검토" | "근거 데이터" | "도구";
  label: string;
  hint: string;
  title: string;
  description: string;
}[] = [
  {
    id: "review",
    group: "검토",
    label: "사업성 검토",
    hint: "단계별로 후보지 검토",
    title: "후보지 사업성 검토",
    description:
      "후보지 선택부터 설계 조건, 발전량·공사비·수익, 사업성 결과까지 순서대로 진행합니다.",
  },
  {
    id: "compare",
    group: "검토",
    label: "후보지 비교",
    hint: "저장한 결과를 나란히",
    title: "후보지·대안 비교",
    description: "사업성 검토 6단계에서 저장한 결과를 골라 발전량, B/C, 필요 판매단가를 나란히 비교합니다.",
  },
  {
    id: "report",
    group: "검토",
    label: "검토 보고서",
    hint: "인쇄·PDF·CSV",
    title: "사업 검토 보고서",
    description: "입력 조건과 6단계 산정 근거를 담은 결과를 저장합니다.",
  },
  {
    id: "data",
    group: "근거 데이터",
    label: "운영실적",
    hint: "K-water 27곳 일별 기록",
    title: "K-water 운영실적 데이터",
    description:
      "아산정수장 일 발전량과 26개 발전소 일 전력거래량을 품질 점검하고 같은 날짜의 물리 모델과 비교합니다.",
  },
  {
    id: "weather",
    group: "근거 데이터",
    label: "기상 관측 검증",
    hint: "기상청 일사계·평년값",
    title: "기상 관측 검증",
    description:
      "ERA5 재분석 일사량을 기상청 ASOS 일사계 관측과 비교해 보정하고, 기상청 평년값(1991~2020)과 기후조건을 대조합니다.",
  },
  {
    id: "model",
    group: "근거 데이터",
    label: "보정 모델 검증",
    hint: "처음 보는 발전소 예측 오차",
    title: "운영실적 보정 모델 검증",
    description:
      "발전소를 하나씩 빼고 학습해 예측하는 장소 분리 검증으로 물리 모델 대비 오차 개선을 확인합니다.",
  },
  {
    id: "validation",
    group: "도구",
    label: "실적 CSV 대조",
    hint: "새 계량 자료 비교",
    title: "신규 실적 CSV 대조",
    description: "계량 자료를 올리면 해당 날짜의 실제 기상으로 설계안을 계산해 월별로 비교합니다.",
  },
];
const axis = { fill: "#6b7280", fontSize: 12 };
const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  fontSize: 13,
};
function Card({
  title,
  aside,
  children,
  className = "",
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"card " + className}>
      {title && (
        <div className="card-heading">
          <h3>{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
function Monthly({
  runs,
  comparison = false,
}: {
  runs: Run[];
  comparison?: boolean;
}) {
  const completed = runs.filter((r) => r.result);
  const data = Array.from({ length: 12 }, (_, i) => ({
    month: `${i + 1}월`,
    ...Object.fromEntries(
      completed.map((r) => [
        r.id,
        (r.result?.monthly.find((m) => m.month === i + 1)?.energy_kwh || 0) /
          1000,
      ]),
    ),
  }));
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        {comparison ? (
          <LineChart
            data={data}
            margin={{ top: 12, right: 12, left: -12, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="month" axisLine={false} tickLine={false} tick={axis} />
            <YAxis axisLine={false} tickLine={false} tick={axis} />
            <Tooltip
              formatter={(v) => [`${num(Number(v), 2)} MWh`]}
              contentStyle={tooltipStyle}
            />
            <Legend wrapperStyle={{ fontSize: 13 }} />
            {completed.map((r, i) => (
              <Line
                key={r.id}
                name={r.snapshot?.design.name || r.design_id}
                type="monotone"
                dataKey={r.id}
                stroke={colors[i % colors.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart
            data={data}
            margin={{ top: 12, right: 12, left: -12, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="month" axisLine={false} tickLine={false} tick={axis} />
            <YAxis axisLine={false} tickLine={false} tick={axis} />
            <Tooltip
              formatter={(v) => [`${num(Number(v), 2)} MWh`, "발전량"]}
              cursor={{ fill: "#f3f4f6" }}
              contentStyle={tooltipStyle}
            />
            {completed.map((r, i) => (
              <Bar
                key={r.id}
                dataKey={r.id}
                fill={colors[i % colors.length]}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
      {completed.length === 0 && (
        <div className="chart-empty">
          분석을 실행하면 월별 발전량이 표시됩니다.
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [projectId, setProjectId] = useState(
      localStorage.getItem("solar-project") || "",
    ),
    [candidateId, setCandidateId] = useState(""),
    [designId, setDesignId] = useState(""),
    [page, setPage] = useState<Page>("review"),
    [step, setStep] = useState(1),
    [registered, setRegistered] = useState<string[]>([]),
    [compareQuery, setCompareQuery] = useState(""),
    [draft, setDraft] = useState<Design | null>(null),
    [activeRun, setActiveRun] = useState<Run | null>(null),
    [historyId, setHistoryId] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [modal, setModal] = useState<Modal>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [running, setRunning] = useState(false),
    [health, setHealth] = useState<Record<string, unknown>>({}),
    [projectMenu, setProjectMenu] = useState(false);
  const candidate =
    workspace?.candidates.find((c) => c.id === candidateId) || null;
  const design = workspace?.designs.find((d) => d.id === designId) || null;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(design);
  const result = activeRun?.status === "completed" ? activeRun.result : null;
  const latestRuns = useMemo(
    () =>
      workspace?.designs
        .map(
          (d) =>
            workspace.runs
              .filter((r) => r.design_id === d.id && r.status === "completed")
              .sort((a, b) => b.created_at.localeCompare(a.created_at))[0],
        )
        .filter(Boolean) || [],
    [workspace],
  );
  const registeredLive = registered.filter((id) =>
    workspace?.designs.some((d) => d.id === id),
  );
  const compareRuns = latestRuns.filter(
    (r) => selected.includes(r.design_id) && registeredLive.includes(r.design_id),
  );
  const history =
    workspace?.runs
      .filter((r) => r.design_id === designId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)) || [];
  const chosenRunId = historyId || history[0]?.id || "";
  const stale =
    !!activeRun &&
    (dirty ||
      (!!design &&
        designInputSignature(activeRun.snapshot.design) !==
          designInputSignature(design)) ||
      (!!candidate &&
        candidateInputSignature(activeRun.snapshot.candidate) !==
          candidateInputSignature(candidate)));
  const handleError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const refreshProjects = useCallback(async () => {
    const p = await api<Project[]>("/projects");
    setProjects(p);
    return p;
  }, []);
  const refreshWorkspace = useCallback(async (id: string) => {
    const w = await api<Workspace>(`/projects/${id}/workspace`);
    setWorkspace(w);
    setCandidateId((old) =>
      w.candidates.some((c) => c.id === old) ? old : w.candidates[0]?.id || "",
    );
    setDesignId((old) =>
      w.designs.some((d) => d.id === old) ? old : w.designs[0]?.id || "",
    );
    return w;
  }, []);
  useEffect(() => {
    void Promise.all([
      refreshProjects(),
      api<Catalog>("/catalogs"),
      api<Record<string, unknown>>("/health"),
    ])
      .then(([p, c, h]) => {
        setCatalog(c);
        setHealth(h);
        if (p.length)
          setProjectId((old) => (p.some((v) => v.id === old) ? old : p[0].id));
      })
      .catch(handleError)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!projectId) return;
    localStorage.setItem("solar-project", projectId);
    setHistoryId("");
    setActiveRun(null);
    setLoading(true);
    setStep(1);
    void refreshWorkspace(projectId)
      .then((w) => {
        // First visit: register every design that already has a finished run.
        const saved =
          readRegistered(projectId) ??
          w.designs
            .filter((d) =>
              w.runs.some((r) => r.design_id === d.id && r.status === "completed"),
            )
            .map((d) => d.id);
        setRegistered(saved);
        setSelected(saved);
      })
      .catch(handleError)
      .finally(() => setLoading(false));
  }, [projectId, refreshWorkspace, handleError]);
  useEffect(() => {
    setDraft(design ? structuredClone(design) : null);
  }, [design?.id, design?.updated_at]);
  useEffect(() => {
    if (!design) return;
    setCandidateId(design.candidate_id);
    setHistoryId("");
  }, [designId]);
  useEffect(() => {
    if (!chosenRunId) {
      setActiveRun(null);
      return;
    }
    let cancelled = false;
    void api<Run>(`/runs/${chosenRunId}`)
      .then((r) => {
        if (!cancelled) setActiveRun(r);
      })
      .catch(handleError);
    return () => {
      cancelled = true;
    };
  }, [chosenRunId, workspace, handleError]);
  useEffect(() => {
    if (
      !workspace?.runs.some(
        (r) => r.status === "running" || r.status === "pending",
      )
    )
      return;
    const timer = setInterval(() => {
      void refreshWorkspace(projectId).catch(handleError);
    }, 1600);
    return () => clearInterval(timer);
  }, [workspace, projectId, refreshWorkspace, handleError]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function mutate<T>(path: string, method = "POST", data?: unknown) {
    setError("");
    return api<T>(path, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function saveDesign() {
    if (!draft) return;
    setSaving(true);
    try {
      const { id, project_id, ...payload } = draft;
      void project_id;
      await mutate(`/designs/${id}`, "PATCH", payload);
      await refreshWorkspace(projectId);
      setNotice(
        "설계 조건을 저장했습니다. 다시 분석하면 변경 내용이 반영됩니다.",
      );
    } catch (e) {
      handleError(e);
    } finally {
      setSaving(false);
    }
  }
  async function analyze(all = false) {
    setRunning(true);
    setError("");
    try {
      if (dirty && draft) await saveDesignStrict();
      const ids = all ? workspace?.designs.map((d) => d.id) || [] : [designId];
      for (const id of ids) await mutate(`/designs/${id}/runs`);
      setHistoryId("");
      await refreshWorkspace(projectId);
      setNotice(
        all
          ? "전체 대안의 분석을 시작했습니다."
          : "발전량과 사업성 분석을 시작했습니다.",
      );
    } catch (e) {
      handleError(e);
    } finally {
      setRunning(false);
    }
  }
  async function saveDesignStrict() {
    if (!draft) return;
    const { id, project_id, ...payload } = draft;
    void project_id;
    await mutate(`/designs/${id}`, "PATCH", payload);
  }
  async function updateCandidate(data: Partial<Candidate>) {
    if (!candidate) return;
    try {
      await mutate(`/candidates/${candidate.id}`, "PATCH", data);
      await refreshWorkspace(projectId);
      setNotice("후보지 정보를 저장했습니다.");
    } catch (e) {
      handleError(e);
      throw e;
    }
  }
  async function addDesign() {
    if (!candidate || !catalog) return;
    try {
      const d = await mutate<Design>(`/projects/${projectId}/designs`, "POST", {
        name: `대안 ${workspace!.designs.filter((d) => d.candidate_id === candidateId).length + 1}`,
        candidate_id: candidateId,
        ...catalog.defaults,
      });
      await refreshWorkspace(projectId);
      setDesignId(d.id);
      setPage("review");
      setSelected((s) => [...s, d.id]);
    } catch (e) {
      handleError(e);
    }
  }
  async function duplicateDesign() {
    if (!design) return;
    try {
      const d = await mutate<Design>(`/designs/${design.id}/duplicate`);
      await refreshWorkspace(projectId);
      setDesignId(d.id);
      setSelected((s) => [...s, d.id]);
      setNotice("설계 대안을 복제했습니다. 조건을 수정해 비교할 수 있습니다.");
    } catch (e) {
      handleError(e);
    }
  }
  function newCandidate(position?: { latitude: number; longitude: number }) {
    const lat = position?.latitude ?? 36.55,
      lng = position?.longitude ?? 127.02;
    const c: Candidate = {
      id: "",
      project_id: projectId,
      name: "새 수면 후보지",
      latitude: lat,
      longitude: lng,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lng - 0.002, lat - 0.0015],
            [lng + 0.002, lat - 0.0015],
            [lng + 0.002, lat + 0.0015],
            [lng - 0.002, lat + 0.0015],
            [lng - 0.002, lat - 0.0015],
          ],
        ],
      },
      exclusions: [],
      grid_point: null,
      cable_distance_m: null,
      water_depth_m: null,
      water_level_m: null,
      site_type: "floating",
      reference_plant_id: null,
      source: "사용자 지정 경계",
    };
    setModal({ kind: "candidate", candidate: c, isNew: true });
  }
  function newCandidateFromWater(water: WaterBody) {
    setModal({
      kind: "candidate",
      isNew: true,
      candidate: {
        id: "",
        project_id: projectId,
        name:
          water.name ||
          `이름 없는 ${water.kind} (${num(water.area_m2 / 10000, 1)} ha)`,
        latitude: water.latitude,
        longitude: water.longitude,
        geometry: water.geometry,
        exclusions: [],
        grid_point: null,
        cable_distance_m: null,
        water_depth_m: null,
        water_level_m: null,
        site_type: "floating",
        reference_plant_id: null,
        source: `수면 경계 © OpenStreetMap contributors · ${water.id} · ${num(water.area_m2 / 10000, 1)} ha`,
      },
    });
  }
  async function saveCandidate(value: Candidate, isNew = false) {
    try {
      const { id, project_id, ...payload } = value;
      void project_id;
      const c = await mutate<Candidate>(
        isNew ? `/projects/${projectId}/candidates` : `/candidates/${id}`,
        isNew ? "POST" : "PATCH",
        payload,
      );
      // A new site gets a default design so it can be analysed right away.
      const d =
        isNew && catalog
          ? await mutate<Design>(`/projects/${projectId}/designs`, "POST", {
              ...catalog.defaults,
              name: "기본안",
              candidate_id: c.id,
            })
          : null;
      await refreshWorkspace(projectId);
      setCandidateId(c.id);
      if (isNew) setDesignId(d?.id || "");
      if (d) setSelected((s) => [...s, d.id]);
      setModal(null);
      setNotice(
        isNew
          ? "후보지와 기본 설계안을 만들었습니다. ‘분석 실행’으로 사업성을 계산하세요."
          : "후보지를 저장했습니다.",
      );
    } catch (e) {
      handleError(e);
    }
  }
  async function remove(kind: "candidate" | "design" | "project", id: string) {
    if (
      !window.confirm(
        "연결된 하위 항목과 분석 결과도 함께 삭제됩니다. 삭제하시겠습니까?",
      )
    )
      return;
    try {
      await mutate(
        `/${kind === "candidate" ? "candidates" : kind === "design" ? "designs" : "projects"}/${id}`,
        "DELETE",
      );
      if (kind === "project") {
        const p = await refreshProjects();
        setProjectId(p[0]?.id || "");
        if (!p.length) setWorkspace(null);
      } else await refreshWorkspace(projectId);
      setNotice("삭제했습니다.");
    } catch (e) {
      handleError(e);
    }
  }
  async function saveProject(
    name: string,
    description: string,
    existing?: Project,
  ) {
    try {
      const p = await mutate<Project>(
        existing ? `/projects/${existing.id}` : "/projects",
        existing ? "PATCH" : "POST",
        { name, description },
      );
      await refreshProjects();
      if (p.id === projectId) await refreshWorkspace(projectId);
      else setProjectId(p.id);
      setModal(null);
    } catch (e) {
      handleError(e);
    }
  }
  async function duplicateProject() {
    try {
      const p = await mutate<Project>(`/projects/${projectId}/duplicate`);
      await refreshProjects();
      setProjectId(p.id);
      setProjectMenu(false);
      setNotice("프로젝트와 후보지·설계를 복제했습니다.");
    } catch (e) {
      handleError(e);
    }
  }
  function exportGeo() {
    if (!candidate?.geometry) return;
    download(
      `${candidate.name}.geojson`,
      JSON.stringify(
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {
                name: candidate.name,
                kind: "candidate",
                latitude: candidate.latitude,
                longitude: candidate.longitude,
                grid_point: candidate.grid_point,
                cable_distance_m: candidate.cable_distance_m,
                water_depth_m: candidate.water_depth_m,
                water_level_m: candidate.water_level_m,
              },
              geometry: candidate.geometry,
            },
            ...candidate.exclusions.map((g) => ({
              type: "Feature",
              properties: { kind: "exclusion" },
              geometry: g,
            })),
          ],
        },
        null,
        2,
      ),
      "application/geo+json",
    );
  }
  async function importGeo(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error("GeoJSON은 5 MB 이하만 가져올 수 있습니다.");
      const value = JSON.parse(await file.text());
      const features =
        value.type === "FeatureCollection"
          ? value.features
          : [
              value.type === "Feature"
                ? value
                : { type: "Feature", properties: {}, geometry: value },
            ];
      const site = features.find(
        (f: { properties?: { kind?: string }; geometry?: { type?: string } }) =>
          f.geometry?.type === "Polygon" && f.properties?.kind !== "exclusion",
      );
      if (!site) throw new Error("Polygon 후보지 경계가 필요합니다.");
      const points = site.geometry.coordinates[0].slice(0, -1);
      await updateCandidate({
        geometry: site.geometry,
        exclusions: features
          .filter(
            (f: { properties?: { kind?: string } }) =>
              f.properties?.kind === "exclusion",
          )
          .map((f: { geometry: unknown }) => f.geometry),
        latitude:
          points.reduce((s: number, p: number[]) => s + p[1], 0) /
          points.length,
        longitude:
          points.reduce((s: number, p: number[]) => s + p[0], 0) /
          points.length,
        ...(site.properties?.grid_point
          ? { grid_point: site.properties.grid_point }
          : {}),
        ...(site.properties?.cable_distance_m != null
          ? { cable_distance_m: site.properties.cable_distance_m }
          : {}),
      });
    } catch (e) {
      handleError(e);
    }
  }
  function selectCandidate(id: string) {
    setCandidateId(id);
    setDesignId(workspace?.designs.find((d) => d.candidate_id === id)?.id || "");
    setHistoryId("");
  }
  /** K-water facility → candidate reproduced by its installed capacity. */
  async function pickPlant(plant: Plant) {
    const existing = workspace?.candidates.find((c) => c.reference_plant_id === plant.id);
    if (existing) return selectCandidate(existing.id);
    if (!catalog) return;
    try {
      const types: SiteType[] = ["floating", "plant", "basin", "land"];
      const siteType = types.includes(plant.type as SiteType) ? (plant.type as SiteType) : "land";
      const c = await mutate<Candidate>(`/projects/${projectId}/candidates`, "POST", {
        name: plant.name,
        latitude: plant.latitude,
        longitude: plant.longitude,
        geometry: null,
        exclusions: [],
        grid_point: null,
        cable_distance_m: null,
        water_depth_m: null,
        water_level_m: null,
        site_type: siteType,
        reference_plant_id: plant.id,
        source: `K-water 운영실적 · ${num(plant.capacity_kw, 1)} kWp · 좌표 ${plant.coordinate_basis}`.slice(0, 300),
      });
      const floating = siteType === "floating";
      const land = catalog.modules.find((m) => m.id === "land_480");
      const equipment = { ...catalog.defaults.equipment };
      const costs = { ...catalog.defaults.costs };
      if (!floating && land) {
        Object.assign(equipment, {
          module_preset: "land_480",
          module_model: land.label,
          module_power_w: land.module_power_w,
          module_width_m: land.module_width_m,
          module_height_m: land.module_height_m,
          module_price: land.module_price,
        });
        Object.assign(costs, { float_per_kw: 0, mooring_per_kw: 0 });
      }
      equipment.capacity_mode = "count";
      equipment.module_count = Math.max(
        1,
        Math.round((plant.capacity_kw * 1000) / Number(equipment.module_power_w || 450)),
      );
      const d = await mutate<Design>(`/projects/${projectId}/designs`, "POST", {
        ...catalog.defaults,
        equipment,
        costs,
        name: `기존 설비 ${num(plant.capacity_kw, 0)} kWp 재현`,
        candidate_id: c.id,
      });
      await refreshWorkspace(projectId);
      setCandidateId(c.id);
      setDesignId(d.id);
      setHistoryId("");
      setNotice(`${plant.name}을(를) 후보지로 추가했습니다. ‘다음’으로 설계 조건을 확인하세요.`);
    } catch (e) {
      handleError(e);
    }
  }
  /** Map click → new candidate at that point (boundary can be drawn later). */
  function createAtPoint(point: { latitude: number; longitude: number }, name: string) {
    setModal({
      kind: "candidate",
      isNew: true,
      candidate: {
        id: "",
        project_id: projectId,
        name,
        latitude: point.latitude,
        longitude: point.longitude,
        geometry: null,
        exclusions: [],
        grid_point: null,
        cable_distance_m: null,
        water_depth_m: null,
        water_level_m: null,
        site_type: "floating",
        reference_plant_id: null,
        source: "지도에서 지정한 위치 (경계 없음 · 모듈 수량 기준)",
      },
    });
  }
  function setRegisteredList(ids: string[]) {
    setRegistered(ids);
    writeRegistered(projectId, ids);
  }
  function registerDesign() {
    if (!designId) return;
    if (!registeredLive.includes(designId)) setRegisteredList([...registeredLive, designId]);
    setSelected((s) => (s.includes(designId) ? s : [...s, designId]));
    setNotice("결과를 저장했습니다. ‘후보지 비교’에서 다른 후보와 비교할 수 있습니다.");
  }
  const currentPending = history.some(
    (r) => r.status === "running" || r.status === "pending",
  );
  const pageInfo = pages.find((p) => p.id === page)!;
  const mapDesigns =
    dirty && draft
      ? workspace?.designs.map((d) => (d.id === draft.id ? draft : d)) || []
      : workspace?.designs || [];
  const lastRun = workspace?.runs.length
    ? [...workspace.runs].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      )[0]
    : null;
  const showRun = page === "report";
  const mappable = workspace?.candidates.filter(hasGeometry) || [];
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("review");
          }}
        >
          수면
          <small>수상태양광 사업성 검토</small>
        </a>
        <nav className="nav" aria-label="화면">
          {(["검토", "근거 데이터", "도구"] as const).map((group) => (
            <div className="nav-group" key={group} aria-label={group} role="group">
              {pages
                .filter((n) => n.group === group)
                .map((n) => {
                  const Icon = icons[n.id];
                  return (
                    <button
                      key={n.id}
                      className={page === n.id ? "active" : ""}
                      aria-current={page === n.id ? "page" : undefined}
                      title={n.hint}
                      onClick={() => setPage(n.id)}
                    >
                      <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
                      {n.label}
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="link" onClick={() => setModal({ kind: "help" })}>
            <CircleHelp size={16} aria-hidden="true" /> 사용 안내
          </button>
          <span>{health.storage === "firestore" ? "Firebase" : "로컬 저장"}</span>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <label className="project-switch">
            <span>프로젝트</span>
            <select
              aria-label="프로젝트 선택"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
              {!projects.length && <option value="">프로젝트 없음</option>}
            </select>
          </label>
          <details className="dropdown" open={projectMenu} onToggle={(e) => setProjectMenu(e.currentTarget.open)}>
            <summary className="btn ghost">프로젝트 관리</summary>
            <div className="menu-list">
              <button onClick={() => { setModal({ kind: "project" }); setProjectMenu(false); }}>
                새 프로젝트
              </button>
              <button
                disabled={!workspace}
                onClick={() => { setModal({ kind: "project", project: workspace?.project }); setProjectMenu(false); }}
              >
                이름·설명 수정
              </button>
              <button disabled={!workspace} onClick={() => void duplicateProject()}>
                프로젝트 복제
              </button>
              <button
                className="danger"
                disabled={!workspace}
                onClick={() => { setProjectMenu(false); void remove("project", projectId); }}
              >
                프로젝트 삭제
              </button>
            </div>
          </details>
          {workspace && (
            <span className="topbar-meta">
              후보지 {workspace.candidates.length} · 대안 {workspace.designs.length} · 최근 분석{" "}
              {lastRun ? date(lastRun.created_at) : "없음"}
            </span>
          )}
        </div>
        <header className="page-header">
          <div>
            <div className="title-row">
              <h1>{pageInfo.title}</h1>
              {workspace?.project.demo && page === "review" && (
                <span className="tag">실데이터 예시</span>
              )}
            </div>
            <p>{pageInfo.description}</p>
          </div>
          {showRun && (
            <button
              className="btn primary"
              disabled={!design || running || currentPending}
              onClick={() => void analyze()}
            >
              {(running || currentPending) && <span className="spinner" />}
              {currentPending ? "분석 진행 중" : "분석 실행"}
            </button>
          )}
        </header>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                void refreshProjects()
                  .then(async () => {
                    if (projectId) await refreshWorkspace(projectId);
                  })
                  .catch(handleError);
              }}
            >
              다시 시도
            </button>
            <button aria-label="오류 닫기" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            {notice}
            <button aria-label="알림 닫기" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {(loading && !workspace) ||
        (!!workspace && workspace.project.id !== projectId) ? (
          <div className="empty">
            <span className="spinner large" />
            <h3>작업 공간을 불러오고 있습니다</h3>
          </div>
        ) : !workspace ? (
          <div className="empty">
            <h3>첫 프로젝트를 만들어 보세요</h3>
            <p>
              후보지를 등록하고 설계 대안의 발전량과 사업성을 비교할 수
              있습니다.
            </p>
            <button
              className="btn primary"
              onClick={() => setModal({ kind: "project" })}
            >
              프로젝트 만들기
            </button>
          </div>
        ) : (
          <>
            {page === "review" && (
              <Wizard
                step={step}
                setStep={setStep}
                workspace={workspace}
                candidate={candidate}
                design={design}
                draft={draft}
                setDraft={setDraft}
                dirty={dirty}
                saving={saving}
                running={running}
                pending={currentPending}
                activeRun={activeRun}
                stale={stale}
                registered={registeredLive.includes(designId)}
                onSelectCandidate={selectCandidate}
                onSelectDesign={setDesignId}
                onPickPlant={pickPlant}
                onCreateAtPoint={createAtPoint}
                onEditCandidate={() => candidate && setModal({ kind: "candidate", candidate })}
                onAddDesign={() => void addDesign()}
                onDuplicateDesign={() => void duplicateDesign()}
                onSaveDesign={() => void saveDesign()}
                onAnalyze={() => analyze()}
                onRegister={registerDesign}
                onOpenCompare={() => setPage("compare")}
                onOpenReport={() => setPage("report")}
                onDeleteCandidate={() => candidate && void remove("candidate", candidate.id)}
                onDeleteDesign={() => design && void remove("design", design.id)}
                onExportGeo={exportGeo}
                onImportGeo={(f) => void importGeo(f)}
                mapEditor={
                  candidate && hasGeometry(candidate) ? (
                    <Card title="경계·배치 편집" className="map-card">
                      <Suspense fallback={<div className="map-loading">지도를 불러오는 중…</div>}>
                        <MapView
                          candidate={candidate}
                          result={stale ? null : result}
                          candidates={mappable}
                          designs={mapDesigns}
                          runs={workspace.runs}
                          selectedDesignId={designId}
                          onSelectCandidate={selectCandidate}
                          onAddCandidate={newCandidate}
                          onUpdate={updateCandidate}
                          onAddWater={newCandidateFromWater}
                        />
                      </Suspense>
                      <p className="hint">
                        경계 그리기·제외 구역·연결점을 지정하면 설치 가능 면적과 배치가 반영됩니다.
                      </p>
                    </Card>
                  ) : null
                }
              />
            )}
            {page === "data" && <PlantRecords onError={handleError} />}
            {page === "model" && <ModelValidation onError={handleError} />}
            {page === "weather" && <WeatherValidation onError={handleError} />}
            {page === "compare" && (() => {
              const q = compareQuery.trim().toLowerCase();
              const items = registeredLive
                .map((id) => workspace.designs.find((d) => d.id === id)!)
                .map((d) => ({
                  d,
                  c: workspace.candidates.find((c) => c.id === d.candidate_id),
                  run: latestRuns.find((r) => r.design_id === d.id),
                }))
                .filter(
                  ({ d, c }) =>
                    !q || d.name.toLowerCase().includes(q) || (c?.name || "").toLowerCase().includes(q),
                );
              const visibleIds = items.map((i) => i.d.id);
              const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
              return (
                <div className="stack">
                  <Card
                    title={`저장된 결과 ${registeredLive.length}개`}
                    aside={
                      <button className="btn" onClick={() => { setPage("review"); setStep(1); }}>
                        새 후보지 검토
                      </button>
                    }
                  >
                    {registeredLive.length === 0 ? (
                      <p className="hint">
                        아직 저장한 결과가 없습니다. ‘사업성 검토’ 6단계에서 ‘결과 저장 · 비교에 등록’을 누르면 여기에 추가됩니다.
                      </p>
                    ) : (
                      <>
                        <div className="compare-tools">
                          <label className="search-box">
                            <Search size={16} aria-hidden="true" />
                            <input
                              type="search"
                              placeholder="후보지·대안 이름 검색"
                              aria-label="저장된 결과 검색"
                              value={compareQuery}
                              onChange={(e) => setCompareQuery(e.target.value)}
                            />
                          </label>
                          <label className="check-all">
                            <input
                              type="checkbox"
                              checked={allOn}
                              onChange={(e) =>
                                setSelected((s) =>
                                  e.target.checked
                                    ? [...new Set([...s, ...visibleIds])]
                                    : s.filter((id) => !visibleIds.includes(id)),
                                )
                              }
                            />
                            {q ? "검색 결과 전체 선택" : "전체 선택"}
                          </label>
                        </div>
                        <ul className="compare-list">
                          {items.map(({ d, c, run }) => {
                            const on = selected.includes(d.id);
                            const color = colors[compareRuns.findIndex((r) => r.design_id === d.id) % colors.length];
                            return (
                              <li key={d.id} className={on ? "on" : ""}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={(e) =>
                                      setSelected((s) =>
                                        e.target.checked ? [...s, d.id] : s.filter((v) => v !== d.id),
                                      )
                                    }
                                  />
                                  {on && run && <i style={{ background: color }} />}
                                  <span className="compare-name">
                                    <b>{c?.name || "후보지"}</b>
                                    <small>{d.name}</small>
                                  </span>
                                </label>
                                <span className="compare-meta">
                                  {run?.result
                                    ? `${num(run.result.annual_kwh / 1000, 0)} MWh · B/C ${num(run.result.economics.bc, 2)} · ${date(run.created_at)}`
                                    : "분석 결과 없음"}
                                </span>
                                <button
                                  className="link"
                                  onClick={() => {
                                    setCandidateId(d.candidate_id);
                                    setDesignId(d.id);
                                    setHistoryId("");
                                    setPage("review");
                                    setStep(6);
                                  }}
                                >
                                  열기
                                </button>
                                <button
                                  className="link muted"
                                  onClick={() => setRegisteredList(registeredLive.filter((v) => v !== d.id))}
                                >
                                  목록에서 빼기
                                </button>
                              </li>
                            );
                          })}
                          {items.length === 0 && <li className="hint">검색 결과가 없습니다.</li>}
                        </ul>
                      </>
                    )}
                  </Card>
                  {compareRuns.length > 0 ? (
                    <>
                      <Card
                        title="월별 발전량"
                        aside={<span className="muted">단위 MWh · 각 대안의 사업성 기준 발전량</span>}
                      >
                        <Monthly runs={compareRuns} comparison />
                      </Card>
                      <Comparison runs={compareRuns} />
                      <p className="hint">
                        총발전량과 용량당 발전량을 함께 보세요. 비용·판매·위치 가정이 다르면 결과도 달라지므로 순위를 매기지 않습니다.
                      </p>
                    </>
                  ) : (
                    registeredLive.length > 0 && (
                      <div className="card empty">
                        <h3>비교할 결과를 고르세요</h3>
                        <p>위 목록에서 체크한 결과가 나란히 표시됩니다.</p>
                      </div>
                    )
                  )}
                </div>
              );
            })()}
            {page === "validation" && (
              <Validation
                key={projectId}
                run={activeRun?.result ? activeRun : null}
                runs={latestRuns}
                onError={handleError}
              />
            )}
            {page === "report" &&
              (result ? (
                <>
                  <div className="report-actions">
                    <span className="muted">
                      {activeRun!.snapshot.candidate.name} · {activeRun!.snapshot.design.name} ·
                      분석 시점의 입력 스냅샷 기준
                    </span>
                    <button
                      className="btn"
                      onClick={() =>
                        window.open(
                          `/api/runs/${activeRun!.id}/csv`,
                          "_blank",
                          "noopener",
                        )
                      }
                    >
                      결과 CSV
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => window.print()}
                    >
                      인쇄 · PDF 저장
                    </button>
                  </div>
                  <ReportBody
                    run={activeRun!}
                    appendix={
                      <>
                        <Cashflow run={activeRun!} />
                        <h3>대안 비교</h3>
                        <Comparison runs={compareRuns.length ? compareRuns : [activeRun!]} />
                      </>
                    }
                  />
                </>
              ) : (
                <EmptyAnalysis />
              ))}
            <footer className="footer">
              사전 검토용 결과입니다. 상세 설계와 인허가 검증은 별도로
              필요합니다. · 기상 {String(health.weather || "ERA5")} · 운영실적 보정{" "}
              {String(health.calibration || "없음")} · 수면 v2.0
            </footer>
          </>
        )}
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === "project"
                ? "프로젝트 설정"
                : modal.kind === "candidate"
                  ? "후보지 설정"
                  : "사용 안내"
            }
          >
            <div className="modal-heading">
              <h2>
                {modal.kind === "project"
                  ? "프로젝트 설정"
                  : modal.kind === "candidate"
                    ? "후보지 설정"
                    : "사용 안내"}
              </h2>
              <button
                className="close"
                aria-label="닫기"
                onClick={() => setModal(null)}
              >
                ×
              </button>
            </div>
            {modal.kind === "project" ? (
              <ProjectForm
                project={modal.project}
                onSave={(n, d) => void saveProject(n, d, modal.project)}
              />
            ) : modal.kind === "candidate" ? (
              <CandidateForm
                candidate={modal.candidate}
                onSubmit={(v) => void saveCandidate(v, modal.isNew)}
              />
            ) : (
              <div className="help">
                <ol>
                  <li>
                    <b>사업성 검토</b>는 위쪽 동그라미 6단계로 진행합니다. 1단계에서 K-water 시설을 고르거나 지도를 클릭해 후보지를 정하고,
                    2단계에서 설계 조건을 입력한 뒤 <b>저장하고 분석</b>을 누릅니다. 3~5단계에서 발전량·공사비·수익을,
                    6단계에서 사업성을 확인하고 <b>결과 저장 · 비교에 등록</b>을 누르면 <b>후보지 비교</b>에 추가됩니다.
                  </li>
                  <li>
                    경계가 있는 후보지는 1단계 <b>경계·배치 편집</b>에서 지역을 검색한 뒤 <b>이 지역 수면 찾기</b>를 누르고, 파란
                    저수지·호수를 클릭해 <b>후보지로 추가</b>합니다. 실제 수면
                    경계와 섬이 그대로 들어갑니다.
                  </li>
                  <li>
                    지도 위 <b>경계 그리기</b>로 수면 경계를, <b>제외 구역</b>
                    으로 설치하지 않을 곳을, <b>연결점</b>으로 육상 전력
                    연결 위치를 지정합니다.
                  </li>
                  <li>
                    오른쪽 패널에서 가이드라인 단계별(① 대상지 · ② 기자재 · ④
                    공사비 · ⑤⑥ 수익·재무) 조건을 입력하고 저장합니다.
                  </li>
                  <li>
                    <b>분석 실행</b>을 누르면 ①~⑥ 단계 결과와 필요 판매단가,
                    발전량 감소 시 B/C를 확인할 수 있습니다.
                  </li>
                </ol>
                <p className="hint">
                  발전량은 후보지 위치의 1991~2020년(기상청 평년 기간, 30년) ERA5
                  시간자료를 기상청 일사계로 보정해 pvlib으로 계산한 뒤, K-water 운영
                  발전소 27곳의 실적으로 검증한 보정 모델을 적용합니다. 근거는 왼쪽
                  ‘근거 데이터’ 메뉴에서 확인합니다. 처음 분석하는 위치는 30년치
                  기상자료를 내려받느라 1분가량 걸립니다.
                </p>
                <h3>용어 설명</h3>
                <dl className="glossary">
                  {Object.entries(GLOSSARY).map(([term, text]) => (
                    <div key={term}>
                      <dt>{term}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
                <p className="hint">
                  저장:{" "}
                  {health.storage === "firestore"
                    ? "Firebase Firestore"
                    : "로컬 SQLite"}{" "}
                  · 인증 없는 로컬 단일 사용자 환경
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ProjectForm({
  project,
  onSave,
}: {
  project?: Project;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(project?.name || ""),
    [description, setDescription] = useState(project?.description || "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name, description);
      }}
    >
      <label className="field">
        <span>프로젝트 이름</span>
        <input
          required
          maxLength={120}
          placeholder="예: 충청권 수상태양광 예비 검토"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span>설명</span>
        <textarea
          maxLength={1000}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <button className="btn primary block">프로젝트 저장</button>
    </form>
  );
}
function EmptyAnalysis() {
  return (
    <div className="card empty">
      <h3>아직 분석 결과가 없습니다</h3>
      <p>오른쪽 위 ‘분석 실행’을 누르면 발전량과 사업성이 계산됩니다.</p>
    </div>
  );
}
function Cashflow({ run }: { run: Run }) {
  return (
    <Card
      title="연도별 현금흐름"
      className="cashflow"
      aside={<span className="muted">금액 만 원 · 전력량 MWh</span>}
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>연도</th>
              <th>발전량</th>
              <th>판매량</th>
              <th>매출</th>
              <th>운영비</th>
              <th>교체비</th>
              <th>순현금흐름</th>
              <th>할인 현금흐름</th>
              <th>누적</th>
            </tr>
          </thead>
          <tbody>
            {run.result?.economics.cashflows.map((c) => (
              <tr key={c.year}>
                <th>{c.year}년차</th>
                <td>{num(c.generation_kwh / 1000, 1)}</td>
                <td>{num(c.sales_kwh / 1000, 1)}</td>
                <td>{num(c.revenue / 10000)}</td>
                <td>{num(c.opex / 10000)}</td>
                <td>{num(c.replacement / 10000)}</td>
                <td>{num(c.net / 10000)}</td>
                <td>{num(c.discounted_net / 10000)}</td>
                <td>{num(c.cumulative / 10000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
function Comparison({
  runs,
  compact = false,
}: {
  runs: Run[];
  compact?: boolean;
}) {
  const grade = [
    "사업성 등급",
    "",
    (r: Run) => gradeInfo[gradeOf(r.result)].label,
  ] as const;
  const metrics = compact
    ? ([
        grade,
        ["DC 용량", "kW", (r: Run) => num(r.result?.capacity_dc_kw, 1)],
        ["연간 발전량", "MWh", (r: Run) => num(r.result!.annual_kwh / 1000, 1)],
        [
          "용량당 발전량",
          "kWh/kW·년",
          (r: Run) => num(r.result?.specific_yield),
        ],
        [
          "초기 투자비",
          "억 원",
          (r: Run) => num(r.result!.economics.capex / 100000000, 2),
        ],
        ["B/C", "", (r: Run) => num(r.result!.economics.bc, 2)],
        [
          "NPV",
          "억 원",
          (r: Run) => num(r.result!.economics.npv / 100000000, 2),
        ],
      ] as const)
    : ([
        grade,
        [
          "후보 수면 면적",
          "ha",
          (r: Run) =>
            r.result!.layout ? num(r.result!.layout.area_m2 / 10000, 2) : "경계 없음",
        ],
        [
          "구조물 · 경사각",
          "",
          (r: Run) =>
            r.result!.steps.site.structure_type === "seasonal"
              ? "가변형"
              : `고정형 ${r.result!.steps.site.tilt}°`,
        ],
        [
          "DC / AC 용량",
          "kW",
          (r: Run) =>
            `${num(r.result!.capacity_dc_kw, 1)} / ${num(r.result!.capacity_ac_kw, 1)}`,
        ],
        ["연간 발전량", "MWh", (r: Run) => num(r.result!.annual_kwh / 1000, 1)],
        [
          "발전량 근거",
          "",
          (r: Run) =>
            r.result!.energy_basis === "calibrated"
              ? `운영실적 보정 (P10 ${num((r.result!.calibration?.annual_p10_kwh ?? 0) / 1000, 0)} MWh)`
              : "물리 모델 단독",
        ],
        [
          "용량당 발전량",
          "kWh/kW·년",
          (r: Run) => num(r.result!.specific_yield),
        ],
        [
          "총 공사비",
          "억 원",
          (r: Run) => num(r.result!.economics.capex / 100000000, 2),
        ],
        [
          "연간 운영비",
          "만 원",
          (r: Run) => num(r.result!.economics.annual_opex / 10000),
        ],
        ["B/C", "", (r: Run) => num(r.result!.economics.bc, 3)],
        [
          "NPV",
          "억 원",
          (r: Run) => num(r.result!.economics.npv / 100000000, 2),
        ],
        ["IRR", "%", (r: Run) => num(r.result!.economics.irr_pct, 2)],
        [
          "단순 회수기간",
          "년",
          (r: Run) => num(r.result!.economics.payback_years, 1),
        ],
        [
          "필요 판매단가",
          "원/kWh",
          (r: Run) => num(r.result!.economics.required_price_per_kwh, 1),
        ],
        ...[0, 1, 2].map(
          (i) =>
            [
              `발전량 감소 시 B/C (${i + 1})`,
              "",
              (r: Run) => {
                const s = r.result!.stress[i];
                return s ? `${num(s.bc, 3)} (${s.label})` : "—";
              },
            ] as const,
        ),
        ["기상자료", "", (r: Run) => r.result!.provenance.weather_source],
        ["미확인 조건", "", () => "인허가·계통·구조·수심"],
      ] as const);
  return (
    <div
      className={
        compact
          ? "table-scroll comparison"
          : "card table-scroll comparison"
      }
    >
      <table>
        <thead>
          <tr>
            <th>비교 지표</th>
            {runs.map((r, i) => (
              <th key={r.id}>
                <span className="table-design">
                  <i style={{ background: colors[i % colors.length] }} />
                  {r.snapshot?.design.name || r.design_id}
                </span>
                <small>
                  {r.snapshot?.candidate.name} · {date(r.created_at)}
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(([label, unit, fn]) => (
            <tr key={label}>
              <th>
                {label}
                <small>{unit}</small>
              </th>
              {runs.map((r) => (
                <td key={r.id}>{fn(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
