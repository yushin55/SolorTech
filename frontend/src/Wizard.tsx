import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { api, num } from "./api";
import type { Candidate, Design, Plant, PlantList, Run, Workspace } from "./types";
import { DesignEditor } from "./Editors";
import { ReviewSteps, Verdict } from "./Steps";
import { gradeInfo, gradeOf } from "./mapData";

const SiteMap = lazy(() => import("./SiteMap"));

export const WIZARD_STEPS = [
  { no: 1, label: "후보지 선택", title: "1단계 · 후보지 선택", lead: "지도에서 위치를 클릭하거나 K-water 보유 시설을 고르세요. 고른 좌표의 30년 기상자료가 발전량 계산에 자동으로 연결됩니다." },
  { no: 2, label: "설계 조건", title: "2단계 · 설계 조건 입력", lead: "구조물·모듈·용량, 공사비 단가, 판매·재무 조건을 입력합니다. ‘다음’을 누르면 저장하고 분석을 시작합니다." },
  { no: 3, label: "발전량 예측", title: "3단계 · 설치용량과 발전량 예측", lead: "설치대상지 조건과 설치용량, 운영실적으로 보정한 월별 발전량과 오차 범위입니다." },
  { no: 4, label: "공사비", title: "4단계 · 개략공사비", lead: "모듈·인버터(가이드라인 단가)와 부유체·계류·전기·토목(견적 가정)으로 산정한 초기 투자비입니다." },
  { no: 5, label: "예상 수익", title: "5단계 · 예상수익", lead: "판매 방식과 단가, 출력제한을 반영한 연간 매출과 판매전력량입니다." },
  { no: 6, label: "사업성 결과", title: "6단계 · 사업성 분석 결과", lead: "B/C·NPV·필요 판매단가로 사업성을 판단하고, 결과를 저장해 후보지 비교에 등록합니다." },
] as const;

type Point = { latitude: number; longitude: number };
type SiteInfo = { province?: string; nearest_city?: string; optimal_tilt?: number; tilt_basis?: string };

export type WizardProps = {
  step: number;
  setStep: (n: number) => void;
  workspace: Workspace;
  candidate: Candidate | null;
  design: Design | null;
  draft: Design | null;
  setDraft: (d: Design) => void;
  dirty: boolean;
  saving: boolean;
  running: boolean;
  pending: boolean;
  activeRun: Run | null;
  stale: boolean;
  registered: boolean;
  mapEditor: ReactNode;
  onSelectCandidate: (id: string) => void;
  onSelectDesign: (id: string) => void;
  onPickPlant: (plant: Plant) => Promise<void>;
  onCreateAtPoint: (point: Point, name: string) => void;
  onEditCandidate: () => void;
  onAddDesign: () => void;
  onDuplicateDesign: () => void;
  onSaveDesign: () => void;
  onAnalyze: () => Promise<void>;
  onRegister: () => void;
  onOpenCompare: () => void;
  onOpenReport: () => void;
  onDeleteCandidate: () => void;
  onDeleteDesign: () => void;
  onExportGeo: () => void;
  onImportGeo: (file: File) => void;
};

export default function Wizard(p: WizardProps) {
  const result = p.activeRun?.status === "completed" ? p.activeRun.result : null;
  const hasRun = !!p.activeRun || p.pending;
  const reachable = (n: number) => n === 1 || (n === 2 ? !!p.candidate && !!p.design : hasRun && !!p.design);
  const done = (n: number) =>
    n === 1 ? !!p.candidate : n === 2 ? !!result && !p.dirty : !!result && !p.stale && n < p.step;
  const info = WIZARD_STEPS[p.step - 1];
  const analysisStep = p.step >= 3;

  async function next() {
    if (p.step === 2) {
      // Save and (re)run when conditions changed or nothing is computed yet.
      if (p.dirty || !result || p.stale) await p.onAnalyze();
    }
    p.setStep(Math.min(6, p.step + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="wizard">
      <ol className="stepper" aria-label="검토 단계">
        {WIZARD_STEPS.map((s) => {
          const state =
            s.no === p.step ? "active" : done(s.no) ? "done" : reachable(s.no) ? "open" : "locked";
          return (
            <li key={s.no} className={state}>
              <button
                disabled={state === "locked"}
                aria-current={s.no === p.step ? "step" : undefined}
                onClick={() => p.setStep(s.no)}
                title={state === "locked" ? "앞 단계를 먼저 마치세요" : s.label}
              >
                <span className="dot">{state === "done" ? <Check size={16} strokeWidth={3} /> : s.no}</span>
                <span className="label">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <section className="wizard-head">
        <h2>{info.title}</h2>
        <p>{info.lead}</p>
        {p.candidate && p.step > 1 && (
          <span className="wizard-context">
            <MapPin size={14} aria-hidden="true" /> {p.candidate.name}
            {p.design && <> · {p.design.name}</>}
          </span>
        )}
      </section>

      {analysisStep && p.activeRun?.status === "failed" && (
        <div className="banner error">
          <span>분석 실패: {p.activeRun.error}</span>
          <button onClick={() => void p.onAnalyze()}>다시 분석</button>
        </div>
      )}
      {analysisStep && p.stale && !p.pending && (
        <div className="banner warning">
          <span>설계 조건이 분석 시점과 다릅니다. 아래는 이전 조건으로 계산한 값입니다.</span>
          <button onClick={() => void p.onAnalyze()}>다시 분석</button>
        </div>
      )}

      <div className="wizard-body">
        {p.step === 1 && <SiteStep {...p} />}
        {p.step === 2 && <DesignStep {...p} />}
        {analysisStep &&
          (p.pending || p.running ? (
            <div className="card empty">
              <span className="spinner large" />
              <h3>발전량과 사업성을 계산하고 있습니다</h3>
              <p>처음 분석하는 위치는 30년치 기상자료를 내려받느라 1~3분 걸립니다. 끝나면 자동으로 표시됩니다.</p>
            </div>
          ) : !result || !p.activeRun ? (
            <div className="card empty">
              <h3>아직 분석 결과가 없습니다</h3>
              <p>2단계에서 설계 조건을 확인하고 ‘다음’을 누르면 분석이 시작됩니다.</p>
              <button className="btn" onClick={() => p.setStep(2)}>설계 조건으로</button>
            </div>
          ) : p.step === 3 ? (
            <ReviewSteps run={p.activeRun} only={["site", "equipment", "energy"]} />
          ) : p.step === 4 ? (
            <ReviewSteps run={p.activeRun} only={["costs"]} />
          ) : p.step === 5 ? (
            <ReviewSteps run={p.activeRun} only={["revenue"]} />
          ) : (
            <FinalStep {...p} run={p.activeRun} />
          ))}
      </div>

      <nav className="wizard-nav" aria-label="단계 이동">
        <button className="btn" disabled={p.step === 1} onClick={() => p.setStep(p.step - 1)}>
          <ChevronLeft size={16} aria-hidden="true" /> 이전
        </button>
        <span className="muted">{p.step} / 6</span>
        {p.step < 6 ? (
          <button
            className="btn primary"
            disabled={
              (p.step === 1 ? !p.candidate || !p.design : p.step === 2 ? !p.design : !result) ||
              p.saving ||
              p.running
            }
            onClick={() => void next()}
          >
            {p.step === 2 && (p.dirty || !result || p.stale) ? "저장하고 분석" : "다음"}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ) : (
          <button className="btn primary" disabled={!result} onClick={p.registered ? p.onOpenCompare : p.onRegister}>
            {p.registered ? "후보지 비교 열기" : "결과 저장 · 비교에 등록"}
          </button>
        )}
      </nav>
    </div>
  );
}

function SiteStep(p: WizardProps) {
  const [plants, setPlants] = useState<Plant[]>([]);
  const [picked, setPicked] = useState<Point | null>(null);
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const focus = picked || (p.candidate ? { latitude: p.candidate.latitude, longitude: p.candidate.longitude } : null);

  useEffect(() => {
    void api<PlantList>("/plants")
      .then((r) => setPlants(r.plants))
      .catch(() => setPlants([]));
  }, []);
  useEffect(() => {
    if (!focus) return setSiteInfo(null);
    const { latitude, longitude } = focus;
    if (latitude < 33 || latitude > 39 || longitude < 124 || longitude > 132) return setSiteInfo(null);
    let cancelled = false;
    void api<SiteInfo>(`/guideline/site?latitude=${latitude}&longitude=${longitude}`)
      .then((r) => !cancelled && setSiteInfo(r))
      .catch(() => !cancelled && setSiteInfo(null));
    return () => {
      cancelled = true;
    };
  }, [focus?.latitude, focus?.longitude]);

  const plantGroups: [string, Plant[]][] = [
    ["수상(댐·저수지)", plants.filter((v) => v.type === "floating")],
    ["정수장·침전지", plants.filter((v) => v.type === "plant" || v.type === "basin")],
    ["기타", plants.filter((v) => !["floating", "plant", "basin"].includes(v.type))],
  ];
  const linkedPlant = plants.find((v) => v.id === p.candidate?.reference_plant_id);
  const inKorea = (pt: Point) => pt.latitude >= 33 && pt.latitude <= 39 && pt.longitude >= 124 && pt.longitude <= 132;

  async function pickPlant(plant: Plant) {
    setPicked(null);
    setBusy(true);
    try {
      await p.onPickPlant(plant);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="site-step">
      <div className="site-panel">
        <label className="field">
          <span>K-water 보유 시설</span>
          <select
            aria-label="K-water 보유 시설 선택"
            value={linkedPlant?.id || ""}
            disabled={busy}
            onChange={(e) => {
              const plant = plants.find((v) => v.id === e.target.value);
              if (plant) void pickPlant(plant);
            }}
          >
            <option value="">{plants.length ? `시설 선택 (${plants.length}곳)` : "불러오는 중…"}</option>
            {plantGroups.map(([label, list]) =>
              list.length ? (
                <optgroup key={label} label={label}>
                  {list.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {num(v.capacity_kw, 0)} kW
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>
        </label>
        <label className="field">
          <span>저장된 후보지</span>
          <select
            aria-label="저장된 후보지 선택"
            value={p.candidate?.id || ""}
            onChange={(e) => {
              setPicked(null);
              p.onSelectCandidate(e.target.value);
            }}
          >
            {!p.workspace.candidates.length && <option value="">아직 없음</option>}
            {p.workspace.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {picked ? (
          <div className="site-card picked">
            <strong>지도에서 고른 위치</strong>
            <p>
              위도 {num(picked.latitude, 4)} · 경도 {num(picked.longitude, 4)}
            </p>
            <WeatherLink info={siteInfo} />
            {inKorea(picked) ? (
              <button
                className="btn primary block"
                onClick={() => {
                  p.onCreateAtPoint(picked, `${siteInfo?.nearest_city || "지정"} 위치 후보지`);
                  setPicked(null);
                }}
              >
                이 위치를 후보지로 등록
              </button>
            ) : (
              <p className="hint">국내(위도 33~39°, 경도 124~132°) 위치만 분석할 수 있습니다.</p>
            )}
            <button className="btn ghost block" onClick={() => setPicked(null)}>
              취소
            </button>
          </div>
        ) : p.candidate ? (
          <div className="site-card">
            <strong>{p.candidate.name}</strong>
            <p>
              위도 {num(p.candidate.latitude, 4)} · 경도 {num(p.candidate.longitude, 4)}
              {linkedPlant && <> · 기존 설비 {num(linkedPlant.capacity_kw, 0)} kW</>}
            </p>
            <WeatherLink info={siteInfo} />
            {linkedPlant && (
              <p className="hint">K-water 운영실적이 있는 시설이라, 예측과 실제 발전량을 함께 비교합니다.</p>
            )}
            <div className="site-actions">
              <button className="btn" onClick={p.onEditCandidate}>
                정보 수정
              </button>
              {p.candidate.geometry && (
                <button className="btn" onClick={() => setEditing((v) => !v)}>
                  {editing ? "경계 편집 닫기" : "경계·배치 편집"}
                </button>
              )}
            </div>
            <details className="site-more">
              <summary>더보기</summary>
              <div className="site-actions">
                {p.candidate.geometry && (
                  <button className="btn ghost" onClick={p.onExportGeo}>
                    GeoJSON 내보내기
                  </button>
                )}
                <label className="btn ghost">
                  GeoJSON으로 경계 가져오기
                  <input
                    type="file"
                    hidden
                    accept=".geojson,.json"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) p.onImportGeo(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button className="btn ghost danger-text" onClick={p.onDeleteCandidate}>
                  후보지 삭제
                </button>
              </div>
            </details>
          </div>
        ) : (
          <div className="site-card">
            <p className="hint">시설을 고르거나 지도를 클릭해 시작하세요.</p>
          </div>
        )}
      </div>
      <div className="card site-map-card">
        <Suspense fallback={<div className="map-loading">지도를 불러오는 중…</div>}>
          <SiteMap
            plants={plants}
            candidates={p.workspace.candidates}
            selectedCandidateId={p.candidate?.id || ""}
            picked={picked}
            onPlant={(plant) => void pickPlant(plant)}
            onCandidate={(id) => {
              setPicked(null);
              p.onSelectCandidate(id);
            }}
            onPoint={setPicked}
          />
        </Suspense>
      </div>
      {editing && p.candidate?.geometry && <div className="site-editor">{p.mapEditor}</div>}
    </div>
  );
}

function WeatherLink({ info }: { info: SiteInfo | null }) {
  return (
    <dl className="weather-link">
      <div>
        <dt>기상자료</dt>
        <dd>이 좌표의 ERA5 1991~2020 시간자료 자동 연동</dd>
      </div>
      {info?.province && (
        <div>
          <dt>권역</dt>
          <dd>
            {info.province} {info.nearest_city}
          </dd>
        </div>
      )}
      {info?.optimal_tilt != null && (
        <div>
          <dt>최적경사각</dt>
          <dd>{info.optimal_tilt}° (가이드라인)</dd>
        </div>
      )}
    </dl>
  );
}

function DesignStep(p: WizardProps) {
  const designs = p.workspace.designs.filter((d) => d.candidate_id === p.candidate?.id);
  return (
    <div className="design-step">
      <div className="design-bar">
        <label className="field">
          <span>설계 대안</span>
          <select aria-label="설계 대안 선택" value={p.design?.id || ""} onChange={(e) => p.onSelectDesign(e.target.value)}>
            {designs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={p.onAddDesign}>
          새 대안
        </button>
        <button className="btn" disabled={!p.design} onClick={p.onDuplicateDesign}>
          대안 복제
        </button>
        <button className="btn ghost danger-text" disabled={!p.design || designs.length < 2} onClick={p.onDeleteDesign}>
          대안 삭제
        </button>
        <span className="hint">같은 후보지에 조건을 달리한 대안을 여러 개 만들어 비교할 수 있습니다.</span>
      </div>
      {p.draft ? (
        <DesignEditor design={p.draft} onChange={p.setDraft} onSave={p.onSaveDesign} dirty={p.dirty} saving={p.saving} />
      ) : (
        <div className="card empty">
          <h3>설계 대안이 없습니다</h3>
          <button className="btn primary" onClick={p.onAddDesign}>
            대안 추가
          </button>
        </div>
      )}
    </div>
  );
}

function FinalStep(p: WizardProps & { run: Run }) {
  const r = p.run.result!;
  const e = r.economics;
  const grade = gradeInfo[gradeOf(r)];
  const stats: [string, string, string, string][] = [
    ["DC 설비용량", num(r.capacity_dc_kw, 1), "kW", `AC ${num(r.capacity_ac_kw)} kW`],
    [
      "연간 발전량",
      num(r.annual_kwh / 1000, 1),
      "MWh",
      r.calibration && r.energy_basis === "calibrated"
        ? `범위 ${num(r.calibration.annual_p10_kwh / 1000, 0)}–${num(r.calibration.annual_p90_kwh / 1000, 0)}`
        : "물리 모델 단독",
    ],
    ["편익·비용비 (B/C)", num(e.bc, 2), "", `총 공사비 ${num(e.capex / 100000000, 1)}억 원`],
    ["필요 판매단가", num(e.required_price_per_kwh, 1), "원/kWh", `가정 단가 ${num(e.effective_price_per_kwh, 0)}원`],
  ];
  return (
    <div className="stack">
      {!p.stale && <Verdict result={r} />}
      <div className="stats">
        {stats.map(([label, value, unit, sub]) => (
          <div className="stat" key={label}>
            <span className="stat-label">
              {label}
              {label.startsWith("편익") && (
                <span className="grade-badge" style={{ color: grade.color, background: grade.soft }}>
                  {grade.label}
                </span>
              )}
            </span>
            <strong>
              {value}
              {unit && <small>{unit}</small>}
            </strong>
            <span className="stat-sub">{sub}</span>
          </div>
        ))}
      </div>
      <ReviewSteps run={p.run} only={["finance"]} />
      <section className="card save-card">
        <div>
          <h3>{p.registered ? "후보지 비교에 등록된 결과입니다" : "결과를 저장하고 비교에 등록하세요"}</h3>
          <p className="hint">
            등록한 결과는 ‘후보지 비교’에서 다른 후보지·대안과 나란히 볼 수 있습니다. 보고서는 인쇄하거나 PDF로 저장할 수 있습니다.
          </p>
        </div>
        <div className="save-actions">
          <button className="btn" onClick={() => window.open(`/api/runs/${p.run.id}/csv`, "_blank", "noopener")}>
            결과 CSV
          </button>
          <button className="btn" onClick={p.onOpenReport}>
            보고서 · PDF
          </button>
          {p.registered ? (
            <button className="btn primary" onClick={p.onOpenCompare}>
              후보지 비교 열기
            </button>
          ) : (
            <button className="btn primary" onClick={p.onRegister}>
              결과 저장 · 비교에 등록
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
