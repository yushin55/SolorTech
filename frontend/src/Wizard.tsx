import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { api, num } from "./api";
import type { Candidate, Catalog, Design, Plant, PlantList, Run, SiteInfo, SiteType, WeatherStation, Workspace } from "./types";
import { SITE_TYPE_OPTIONS, siteTypeLabel } from "./types";
import { DesignEditor } from "./Editors";
import {
  AngleComparison,
  AssumptionTable,
  CapacityPlanCard,
  CashInflow,
  ResultSummary,
  FinancingCard,
  WeatherStationCard,
} from "./Business";
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
  onCreateAtPoint: (point: Point, name: string, siteType: SiteType) => Promise<void>;
  onMoveCandidate: (point: Point) => Promise<void>;
  onChangeSiteType: (siteType: SiteType) => Promise<void>;
  onPatchCandidate: (data: Partial<Candidate>) => Promise<void>;
  onApplyAngle: (tilt: number, azimuth: number) => void;
  catalog: Catalog | null;
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
            <div className="stack">
              <WeatherStationCard result={result} />
              <CapacityPlanCard result={result} />
              <AngleComparison result={result} onApply={p.stale ? undefined : p.onApplyAngle} />
              <ReviewSteps run={p.activeRun} only={["site", "equipment", "energy"]} />
            </div>
          ) : p.step === 4 ? (
            <ReviewSteps run={p.activeRun} only={["costs"]} />
          ) : p.step === 5 ? (
            <div className="stack">
              <CashInflow result={result} />
              <ReviewSteps run={p.activeRun} only={["revenue"]} />
            </div>
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
  const [stations, setStations] = useState<WeatherStation[]>([]);
  const [picked, setPicked] = useState<Point | null>(null);
  const [pickName, setPickName] = useState("");
  const [pickType, setPickType] = useState<SiteType>("land");
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const focus = picked || (p.candidate ? { latitude: p.candidate.latitude, longitude: p.candidate.longitude } : null);

  useEffect(() => {
    void api<PlantList>("/plants")
      .then((r) => setPlants(r.plants))
      .catch(() => setPlants([]));
    void api<{ stations: WeatherStation[] }>("/weather-stations")
      .then((r) => setStations(r.stations))
      .catch(() => setStations([]));
  }, []);
  useEffect(() => {
    if (picked && siteInfo?.nearest_city && !pickName) setPickName(`${siteInfo.nearest_city} 후보지`);
  }, [siteInfo?.nearest_city, picked]);
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
            <p className="coords">
              위도 {num(picked.latitude, 5)} · 경도 {num(picked.longitude, 5)}
            </p>
            <WeatherLink info={siteInfo} />
            {inKorea(picked) ? (
              <>
                <label className="field">
                  <span>후보지 이름</span>
                  <input
                    aria-label="새 후보지 이름"
                    value={pickName}
                    placeholder="예: 예산 지정 위치"
                    onChange={(e) => setPickName(e.target.value)}
                  />
                </label>
                <SiteTypeSelect value={pickType} onChange={setPickType} label="설치장소 유형" />
                <button
                  className="btn primary block"
                  disabled={busy || !pickName.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await p.onCreateAtPoint(picked, pickName.trim(), pickType);
                      setPicked(null);
                      setPickName("");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  이 위치를 후보지로 등록 (좌표 저장)
                </button>
                {p.candidate && !p.candidate.geometry && !p.candidate.reference_plant_id && (
                  <button
                    className="btn block"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await p.onMoveCandidate(picked);
                        setPicked(null);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    ‘{p.candidate.name}’ 위치를 여기로 변경
                  </button>
                )}
              </>
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
            <p className="coords">
              저장된 좌표 · 위도 {num(p.candidate.latitude, 5)} · 경도 {num(p.candidate.longitude, 5)}
              {linkedPlant && <> · 기존 설비 {num(linkedPlant.capacity_kw, 0)} kW</>}
            </p>
            <SiteTypeSelect
              value={p.candidate.site_type}
              disabled={busy}
              label="설치장소 유형"
              onChange={async (t) => {
                setBusy(true);
                try {
                  await p.onChangeSiteType(t);
                } finally {
                  setBusy(false);
                }
              }}
            />
            {(p.candidate.site_type === "land" || p.candidate.site_type === "building") && (
              <SiteConditions key={p.candidate.id + p.candidate.site_type} candidate={p.candidate} onSave={p.onPatchCandidate} />
            )}
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
            stations={stations}
            nearestStation={siteInfo?.weather_station ?? null}
            focus={focus}
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

function SiteTypeSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: SiteType;
  onChange: (t: SiteType) => void;
  label: string;
  disabled?: boolean;
}) {
  const legacy = !SITE_TYPE_OPTIONS.some((o) => o.value === value);
  return (
    <label className="field">
      <span>{label}</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as SiteType)}>
        {legacy && <option value={value}>{siteTypeLabel(value)}</option>}
        {SITE_TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <small className="field-note">
        {value === "floating"
          ? "설비 단계에서 부유체·계류장치 제원·단가를 입력합니다."
          : "부유체·계류장치는 계산에서 빠지고, 구조물 단가를 입력합니다."}
      </small>
    </label>
  );
}

function WeatherLink({ info }: { info: SiteInfo | null }) {
  const st = info?.weather_station;
  return (
    <dl className="weather-link">
      <div>
        <dt>기상 관측소</dt>
        <dd>
          {st ? (
            <>
              <b>
                {st.name} ({st.stn})
              </b>{" "}
              · 후보지에서 {num(st.distance_km ?? 0, 1)} km
            </>
          ) : (
            "좌표를 고르면 가장 가까운 관측소를 찾습니다"
          )}
        </dd>
      </div>
      <div>
        <dt>일사 보정</dt>
        <dd>
          {info?.irradiance_station ? (
            <>
              가장 가까운 일사계 관측소 <b>{info.irradiance_station.name}</b> ·{" "}
              {num(info.irradiance_station.distance_km, 1)} km
            </>
          ) : (
            "100 km 안에 일사 관측 자료가 있는 관측소 없음"
          )}
        </dd>
      </div>
      <div>
        <dt>예측 기상자료</dt>
        <dd>이 좌표의 ERA5 1991~2020 시간자료</dd>
      </div>
      {info?.optimal_tilt != null && (
        <div>
          <dt>최적경사각</dt>
          <dd>
            {info.optimal_tilt}° (가이드라인{info.province ? ` · ${info.province}` : ""})
          </dd>
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
        <DesignEditor
          design={p.draft}
          onChange={p.setDraft}
          onSave={p.onSaveDesign}
          dirty={p.dirty}
          saving={p.saving}
          context={{
            candidate: p.candidate,
            modules: p.catalog?.modules ?? [],
            angles: p.activeRun?.result?.steps.site.angles ?? null,
            analysedTilt: p.activeRun?.result?.steps.site.tilt,
            requiredPrice: p.activeRun?.result?.economics.required_price_per_kwh ?? null,
          }}
        />
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
      <section className="card">
        <div className="card-heading">
          <h3>사업성 분석 결과</h3>
          <span className="muted">현금 유출(투자·운영비) 대비 현금 유입(예측 발전량 × 판매단가)</span>
        </div>
        <ResultSummary result={r} />
        <FinancingCard result={r} />
      </section>
      <ReviewSteps run={p.run} only={["finance"]} />
      <AssumptionTable rows={r.assumption_table} />
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

type ConditionField = { key: keyof Candidate; label: string; unit: string; optional?: boolean; min?: number; max?: number };
const LAND_FIELDS: ConditionField[] = [
  { key: "boundary_setback_m", label: "경계 이격", unit: "m", min: 0, max: 100 },
  { key: "terrain_slope_deg", label: "부지 경사 (빈칸 = 미조사)", unit: "°", optional: true, min: 0, max: 89 },
  { key: "slope_limit_deg", label: "경사 검토 한계", unit: "°", min: 0, max: 89 },
];
const ROOF_FIELDS: ConditionField[] = [
  { key: "boundary_setback_m", label: "지붕 가장자리 이격", unit: "m", min: 0, max: 100 },
  { key: "roof_tilt_deg", label: "지붕 경사", unit: "°", min: 0, max: 90 },
  { key: "roof_azimuth_deg", label: "지붕 방위 (동 90 · 남 180 · 서 270)", unit: "°", min: 90, max: 270 },
  { key: "roof_allowable_load_kg_m2", label: "허용 추가하중 (빈칸 = 미확인)", unit: "kg/m²", optional: true, min: 0, max: 10000 },
  { key: "roof_system_load_kg_m2", label: "설치 추가하중 (빈칸 = 미확인)", unit: "kg/m²", optional: true, min: 0, max: 10000 },
];
const CONDITION_DEFAULTS: Partial<Record<keyof Candidate, number>> = {
  boundary_setback_m: 0,
  slope_limit_deg: 15,
  roof_tilt_deg: 10,
  roof_azimuth_deg: 180,
};

/** 지상·건축물 현장 조사 조건 (팀 레포에서 이식): 경계 이격, 부지 경사, 지붕 설치 방식·하중. */
function SiteConditions({ candidate, onSave }: { candidate: Candidate; onSave: (data: Partial<Candidate>) => Promise<void> }) {
  const roof = candidate.site_type === "building";
  const fields = roof ? ROOF_FIELDS : LAND_FIELDS;
  const initial = () =>
    Object.fromEntries(
      fields.map((f) => {
        const v = candidate[f.key] as number | null | undefined;
        return [f.key, v == null ? (f.optional ? "" : String(CONDITION_DEFAULTS[f.key] ?? "")) : String(v)];
      }),
    ) as Record<string, string>;
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [mount, setMount] = useState<"rack" | "flush">(candidate.roof_mount ?? "rack");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const data: Record<string, number | string | null> = {};
    for (const f of fields) {
      const text = values[f.key].trim();
      data[f.key] = text === "" && f.optional ? null : Number(text);
    }
    if (roof) data.roof_mount = mount;
    setBusy(true);
    try {
      await onSave(data as Partial<Candidate>);
    } finally {
      setBusy(false);
    }
  };
  const invalid = fields.some((f) => {
    const text = values[f.key].trim();
    if (text === "") return !f.optional;
    const n = Number(text);
    return !Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max);
  });
  return (
    <details className="site-conditions" open>
      <summary>{roof ? "건축물 현장 조건" : "지상 부지 현장 조건"}</summary>
      {roof && (
        <label className="field">
          <span>설치 방식</span>
          <select aria-label="지붕 설치 방식" value={mount} onChange={(e) => setMount(e.target.value as "rack" | "flush")}>
            <option value="rack">가대형 (설계 경사각 적용)</option>
            <option value="flush">지붕 밀착형 (지붕 경사·방위 그대로)</option>
          </select>
        </label>
      )}
      <div className="fields">
        {fields.map((f) => (
          <label className="field" key={f.key}>
            <span>{f.label}</span>
            <div className="input-unit">
              <input
                aria-label={f.label}
                type="number"
                step="any"
                value={values[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              <small>{f.unit}</small>
            </div>
          </label>
        ))}
      </div>
      <p className="hint">
        {roof
          ? "지붕 밀착형은 지붕 경사·방위로 발전량을 계산하고 밀착형 온도 모델을 씁니다. 하중이 비어 있거나 설치 하중이 허용 하중을 넘으면 결과에 경고가 붙습니다."
          : "경계 이격만큼 지도 경계 안쪽을 줄여 배치합니다. 부지 경사가 비어 있거나 검토 한계를 넘으면 결과에 경고가 붙습니다. 인허가 기준 판정은 아닙니다."}
      </p>
      <button className="btn block" disabled={busy || invalid} onClick={save}>
        {busy ? "저장 중…" : "현장 조건 저장"}
      </button>
    </details>
  );
}
