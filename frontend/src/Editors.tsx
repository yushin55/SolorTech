import { useEffect, useState } from "react";
import type { AngleRow, CapacityPlan, Candidate, Catalog, CatalogInverter, Design, Settings } from "./types";
import { SITE_TYPE_OPTIONS } from "./types";
import { api, num } from "./api";
export type FieldDef = {
  key: string;
  label: string;
  unit?: string;
  required?: boolean;
  step?: number;
  options?: [string, string][];
  /** Field is shown only when this returns true for the current values. */
  show?: (values: Settings) => boolean;
  /** Field is shown but cannot be edited (with the reason) when this returns a string. */
  disabled?: (values: Settings) => string | false;
  /** Short provenance badge, e.g. the guideline table or "견적 가정". */
  source?: string;
  text?: boolean;
};
// ① 패널 각도·방향 (가이드라인 부록 2.2, 3.5.1)
const angleFields: FieldDef[] = [
  {
    key: "structure_type",
    label: "구조물 형식",
    options: [
      ["fixed", "고정형 (경사각 고정)"],
      ["seasonal", "가변형 (계절별 경사각 조정)"],
    ],
    source: "표 3-17",
  },
  {
    key: "tilt_mode",
    label: "설치 경사각 결정",
    options: [
      ["guideline", "가이드라인 지역별 최적경사각 자동"],
      ["manual", "직접 입력"],
    ],
    show: (v) => v.structure_type !== "seasonal",
    source: "표 3-18·3-19",
  },
  {
    key: "tilt",
    label: "설치 경사각",
    unit: "°",
    show: (v) => v.tilt_mode === "manual" && v.structure_type !== "seasonal",
  },
  { key: "azimuth", label: "패널 방위각 (동 90° · 남 180° · 서 270°)", unit: "°", source: "3.5.1" },
  { key: "shading_loss_pct", label: "주변 장애물 음영 손실", unit: "%", step: 0.5, source: "사용자 가정" },
  {
    key: "purpose",
    label: "태양광 용도",
    options: [
      ["sale", "발전용 (전력 판매)"],
      ["self", "소내소비용 (자가 사용 후 잉여 판매)"],
    ],
    source: "부록 2.4",
  },
];
// ② 설비 조건 — 배치·전기 사양 (부록 2.3)
const layoutFields: FieldDef[] = [
  { key: "array_rows", label: "어레이 세로 단수", unit: "단", source: "표 3-15" },
  {
    key: "spacing_mode",
    label: "어레이 행간 이격",
    options: [
      ["guideline", "가이드라인 산출식 (동지 10시 태양고도 23°)"],
      ["manual", "직접 입력"],
    ],
    source: "표 3-22",
  },
  {
    key: "row_spacing_m",
    label: "행간 이격",
    unit: "m",
    step: 0.1,
    show: (v) => v.spacing_mode === "manual",
  },
  {
    key: "inverter_configuration",
    label: "인버터 구성",
    options: [
      ["auto", "가이드라인 원칙 (멀티, 20% 초과 절감 시 단일)"],
      ["multi", "멀티구성"],
      ["single", "단일구성"],
    ],
    source: "표 3-12",
  },
];
const electricalFields: FieldDef[] = [
  { key: "vmp_v", label: "모듈 최대전압 Vmp", unit: "V", step: 0.01, source: "표 3-13" },
  { key: "voc_v", label: "모듈 개방전압 Voc", unit: "V", step: 0.01, source: "표 3-13" },
  { key: "voltage_temp_coeff_pct", label: "전압 온도계수", unit: "%/°C", step: 0.01 },
  {
    key: "energy_basis",
    label: "사업성에 쓸 발전량",
    options: [
      ["calibrated", "운영실적 보정값 (장소 분리 검증 모델)"],
      ["physics", "물리 모델 단독 (pvlib)"],
    ],
  },
  { key: "system_loss_pct", label: "시스템 손실률 · 물리 모델", unit: "%", step: 0.1 },
  { key: "inverter_efficiency", label: "인버터 효율 · 물리 모델", unit: "0–1", step: 0.01 },
  { key: "gamma_pdc", label: "출력 온도계수 · 물리 모델", unit: "/°C", step: 0.0001 },
];
const customModuleFields: FieldDef[] = [
  { key: "module_manufacturer", label: "제조사", text: true, required: false },
  { key: "module_model", label: "모델명", text: true },
  { key: "module_power_w", label: "정격출력", unit: "W", step: 5 },
  { key: "module_width_m", label: "가로(폭)", unit: "m", step: 0.001 },
  { key: "module_height_m", label: "세로(길이)", unit: "m", step: 0.001 },
  { key: "module_price", label: "모듈 단가", unit: "원/장" },
  { key: "module_source", label: "자료 출처 (예: 제조사 데이터시트 이름·URL)", text: true, required: false },
];
const notFloating = (v: Settings) =>
  v.site_type !== "floating" ? "설치장소 유형이 ‘수상’일 때만 입력" : false;
// ④ 개략공사비 (부록 2.5) — 현금 유출
const costs: FieldDef[] = [
  { key: "module_unit_price", label: "모듈 견적 단가 (0 = 카탈로그 가정)", unit: "원/장", source: "견적", required: false },
  { key: "inverter_unit_price", label: "인버터 견적 단가 (0 = 환산 단가)", unit: "원/대", source: "견적", required: false,
    show: (v) => v.inverter_model === "dass_dsp_33125kshk_nj1" },
  { key: "float_per_kw", label: "부유체", unit: "원/kW", source: "견적 가정", disabled: notFloating },
  { key: "mooring_per_kw", label: "계류장치", unit: "원/kW", source: "견적 가정", disabled: notFloating },
  {
    key: "structure_per_kw",
    label: "구조물 (지상·건축물·침전지)",
    unit: "원/kW",
    source: "견적 가정",
    disabled: (v) => (v.site_type === "floating" ? "수상은 부유체·계류장치로 산정" : false),
  },
  { key: "electrical_per_kw", label: "전기공사·기타 자재", unit: "원/kW", source: "견적 가정" },
  { key: "junction_box_unit", label: "접속반 단가 (0 = 전기공사 포함)", unit: "원/면", source: "견적 가정" },
  { key: "cable_per_m", label: "케이블 (연계·수중)", unit: "원/m", source: "견적 가정" },
  { key: "civil", label: "시공(토목공사) 총액", unit: "원", source: "견적 가정" },
  { key: "design_permitting", label: "설계·인허가 총액", unit: "원", source: "견적 가정" },
  { key: "grid_connection", label: "계통연계(한전) 총액", unit: "원", source: "견적 가정" },
  { key: "annual_om_per_kw", label: "연간 유지관리비", unit: "원/kW·년", source: "견적 가정" },
  { key: "replacement_year", label: "인버터 교체 연차", unit: "년차" },
];
// ⑤ 예상수익 · ⑥ 재무성 분석 (부록 2.6·2.7) — 현금 유입
const finance: FieldDef[] = [
  {
    key: "sale_mode",
    label: "판매 단가 방식",
    options: [
      ["fixed", "사용자 설정 판매단가 (고정)"],
      ["smp_rec", "SMP + REC"],
    ],
    source: "부록 2.6",
  },
  {
    key: "fixed_price",
    label: "판매단가 (상·하한 제한 없음)",
    unit: "원/kWh",
    step: 0.1,
    show: (v) => v.sale_mode === "fixed",
    source: "사용자 설정",
  },
  { key: "smp_price", label: "SMP", unit: "원/kWh", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_price", label: "REC 가격", unit: "원/REC", show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_weight", label: "REC 가중치 (고시 확인)", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "price_scenarios", label: "비교할 판매단가 시나리오", unit: "원/kWh, 쉼표 구분", text: true, required: false },
  { key: "self_use_kwh", label: "연간 소내 소비전력량", unit: "kWh", show: (v) => v.purpose === "self" },
  { key: "retail_price", label: "소내 사용 전력 단가", unit: "원/kWh", step: 0.1, show: (v) => v.purpose === "self" },
  { key: "years", label: "사업기간", unit: "년" },
  { key: "discount_pct", label: "할인율", unit: "%", step: 0.1 },
  { key: "degradation_pct", label: "연간 열화율", unit: "%", step: 0.1 },
  { key: "curtailment_pct", label: "출력제한 가정", unit: "%", step: 0.1 },
  { key: "stress_pcts", label: "발전량 감소 점검", unit: "%, 쉼표 구분", text: true },
  { key: "loan_pct", label: "PF 융자 비율 (0 = 자기자본만)", unit: "% (총 공사비)", step: 1, source: "사용자 가정" },
  { key: "loan_rate_pct", label: "융자 금리", unit: "%/년", step: 0.1, show: (v) => Number(v.loan_pct) > 0 },
  { key: "loan_years", label: "상환 기간 (원리금균등)", unit: "년", show: (v) => Number(v.loan_pct) > 0 },
  { key: "grace_years", label: "거치 기간 (이자만 상환)", unit: "년", show: (v) => Number(v.loan_pct) > 0 },
];
export function Fields({
  fields,
  values,
  onChange,
}: {
  fields: FieldDef[];
  values: Settings;
  onChange: (key: string, value: number | string) => void;
}) {
  return (
    <div className="fields">
      {fields
        .filter((f) => !f.show || f.show(values))
        .map((f) => {
          const off = f.disabled?.(values) || false;
          return (
            <label
              className={"field" + (f.options || f.text ? " full" : "") + (off ? " is-disabled" : "")}
              key={f.key}
            >
              <span>
                {f.label}
                {f.source && (
                  <em className={"field-source" + (f.source === "견적 가정" ? " assumed" : "")}>
                    {f.source}
                  </em>
                )}
              </span>
              {f.options ? (
                <select
                  aria-label={f.label}
                  value={values[f.key]}
                  disabled={!!off}
                  onChange={(e) => onChange(f.key, e.target.value)}
                >
                  {!f.options.some((v) => v[0] === values[f.key]) && (
                    <option value={values[f.key]}>{values[f.key]}</option>
                  )}
                  {f.options.map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="input-unit">
                  <input
                    aria-label={f.label}
                    required={!off && f.required !== false}
                    disabled={!!off}
                    type={f.text ? "text" : "number"}
                    step={f.step || 1}
                    value={values[f.key] ?? ""}
                    onChange={(e) =>
                      onChange(
                        f.key,
                        f.text ? e.target.value : e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                  />
                  {f.unit && <small>{f.unit}</small>}
                </div>
              )}
              {off && <small className="field-note">{off}</small>}
            </label>
          );
        })}
    </div>
  );
}
const listText = (value: unknown) => (Array.isArray(value) ? value.join(", ") : String(value ?? ""));
/** Comma list → number[]; invalid text stays text so the server rejects it visibly. */
export function parseStress(value: unknown): number[] | string {
  if (Array.isArray(value)) return value as number[];
  const parts = String(value)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const numbers = parts.map(Number);
  return numbers.every((n) => Number.isFinite(n)) ? numbers : String(value);
}

/** Bilinear estimate of the annual-energy ratio from the analysed tilt × azimuth grid. */
export function estimateAngle(rows: AngleRow[], tilt: number, azimuth: number) {
  const tilts = [...new Set(rows.map((r) => r.tilt))].sort((a, b) => a - b);
  const azs = [...new Set(rows.map((r) => r.azimuth))].sort((a, b) => a - b);
  if (tilt < tilts[0] || tilt > tilts[tilts.length - 1] || azimuth < azs[0] || azimuth > azs[azs.length - 1])
    return null;
  const bracket = (list: number[], v: number) => {
    let i = list.findIndex((x) => x >= v);
    if (i <= 0) i = 1;
    const a = list[i - 1],
      b = list[i];
    return [a, b, b === a ? 0 : (v - a) / (b - a)] as const;
  };
  const [t0, t1, ft] = bracket(tilts, tilt);
  const [a0, a1, fa] = bracket(azs, azimuth);
  const at = (t: number, a: number) => rows.find((r) => r.tilt === t && r.azimuth === a);
  const c = [at(t0, a0), at(t0, a1), at(t1, a0), at(t1, a1)];
  if (c.some((x) => !x)) return null;
  const mix = (k: "ratio" | "annual_kwh") =>
    (1 - ft) * ((1 - fa) * c[0]![k] + fa * c[1]![k]) + ft * ((1 - fa) * c[2]![k] + fa * c[3]![k]);
  return { ratio: mix("ratio"), annual_kwh: mix("annual_kwh") };
}

type Tab = "angles" | "equipment" | "costs" | "finance";
type Modules = Catalog["modules"];
export type DesignContext = {
  candidate?: Candidate | null;
  modules?: Modules;
  inverters?: CatalogInverter[];
  /** Angle comparison of the latest analysis of this design, if any. */
  angles?: { rows: AngleRow[]; selected: { tilt: number; azimuth: number } } | null;
  /** Latest analysed tilt (guideline-resolved) for the comparison readout. */
  analysedTilt?: number;
  requiredPrice?: number | null;
};

const MODE_OPTIONS: [string, string, string][] = [
  ["site_area", "부지 면적 입력", "부지 면적과 모듈을 고르면 설치 가능한 모듈 수와 총 설비용량을 계산합니다."],
  ["capacity", "총 설비용량 입력", "원하는 총 설비용량과 모듈을 고르면 필요한 모듈 수와 실제 설치용량을 계산합니다."],
  ["count", "모듈 수량 직접 입력", "기존 설비 재현처럼 모듈 수를 알고 있을 때 씁니다."],
];

function CapacityPreview({ design, candidate }: { design: Design; candidate?: Candidate | null }) {
  const [plan, setPlan] = useState<CapacityPlan | null>(null);
  const [error, setError] = useState("");
  const eq = design.equipment;
  const key = JSON.stringify(eq);
  useEffect(() => {
    if (!candidate) return;
    let live = true;
    const t = setTimeout(() => {
      api<CapacityPlan>("/capacity-preview", {
        method: "POST",
        body: JSON.stringify({ latitude: candidate.latitude, longitude: candidate.longitude, equipment: eq }),
      })
        .then((p) => {
          if (!live) return;
          setPlan(p);
          setError("");
        })
        .catch((e: Error) => {
          if (!live) return;
          setPlan(null);
          setError(e.message);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, candidate?.latitude, candidate?.longitude]);
  if (!candidate) return null;
  if (error) return <div className="capacity-preview error">{error}</div>;
  if (!plan) return <div className="capacity-preview muted">계산 중…</div>;
  const adjusted = plan.modules_used != null && plan.modules_used !== plan.requested_modules;
  return (
    <div className="capacity-preview" aria-live="polite">
      <div className="capacity-main">
        <div>
          <span>{plan.mode === "capacity" ? "필요한 모듈 수" : "설치 가능한 모듈 수"}</span>
          <strong>
            {num(plan.requested_modules, 0)}
            <small>장</small>
          </strong>
        </div>
        <div>
          <span>{plan.mode === "capacity" ? "실제 설치용량 (모듈용량 × 모듈 수)" : "총 설비용량"}</span>
          <strong>
            {num(plan.requested_dc_kw, 1)}
            <small>kW</small>
          </strong>
        </div>
      </div>
      {adjusted && (
        <p className="hint">
          인버터 직렬 구성(표 3-13)에 맞추면 {num(plan.modules_used!, 0)}장 · {num(plan.dc_kw!, 1)} kW로 계산됩니다.
        </p>
      )}
      <dl className="assumption-mini">
        <div>
          <dt>모듈 1장 기준</dt>
          <dd>
            {num(plan.module_power_w, 0)} W · 점유면적 {num(plan.module_footprint_m2, 2)} m²
          </dd>
        </div>
        <div>
          <dt>배치 간격 (가정)</dt>
          <dd>
            어레이 행 피치 {num(plan.row_pitch_m, 2)} m (행간 이격 {num(plan.row_gap_m, 2)} m · {plan.array_rows}단)
            {plan.tilt != null && <> · 경사 {num(plan.tilt, 0)}°</>}
          </dd>
        </div>
        {plan.mode === "site_area" && (
          <>
            <div>
              <dt>여유 면적 (가정)</dt>
              <dd>
                {num(plan.reserve_pct!, 0)}% 제외 → 배치 가능 {num(plan.usable_area_m2!, 0)} m² / 부지{" "}
                {num(plan.site_area_m2!, 0)} m²
              </dd>
            </div>
            <div>
              <dt>지면 점유율</dt>
              <dd>모듈 면적 ÷ 부지 면적 = {num(plan.ground_coverage_pct!, 1)}%</dd>
            </div>
          </>
        )}
      </dl>
      <p className="hint">
        {plan.pitch_basis}. 여유 면적은 통로·유지보수 공간·외곽 이격을 묶은 초기 데모 가정값이며, 실제 배치 설계로 바꿔야 합니다.
      </p>
    </div>
  );
}

function ModulePicker({
  design,
  modules,
  onChange,
}: {
  design: Design;
  modules: Modules;
  onChange: (equipment: Settings) => void;
}) {
  const eq = design.equipment;
  const preset = modules.find((m) => m.id === eq.module_preset);
  const pick = (id: string) => {
    const m = modules.find((x) => x.id === id);
    if (!m) return onChange({ ...eq, module_preset: "custom" });
    onChange({
      ...eq,
      module_preset: m.id,
      module_manufacturer: m.manufacturer || "",
      module_model: m.label,
      module_power_w: m.module_power_w,
      module_width_m: m.module_width_m,
      module_height_m: m.module_height_m,
      module_price: m.module_price,
      module_source: m.source,
      ...(m.vmp_v != null && { vmp_v: m.vmp_v }),
      ...(m.voc_v != null && { voc_v: m.voc_v }),
      ...(m.voltage_temp_coeff_pct != null && { voltage_temp_coeff_pct: m.voltage_temp_coeff_pct }),
      ...(m.gamma_pdc != null && { gamma_pdc: m.gamma_pdc }),
    });
  };
  return (
    <div className="module-picker">
      <label className="field full">
        <span>
          모듈 (카탈로그)<em className="field-source">제조사 자료</em>
        </span>
        <select aria-label="모듈" value={String(eq.module_preset)} onChange={(e) => pick(e.target.value)}>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.manufacturer && !m.manufacturer.startsWith("가이드라인") ? `${m.manufacturer} · ` : "가이드라인 · "}
              {m.label} · {m.module_power_w} W
            </option>
          ))}
          <option value="custom">직접 입력 (다른 제조사 카탈로그)</option>
        </select>
      </label>
      {preset ? (
        <dl className="module-spec">
          <div>
            <dt>제조사</dt>
            <dd>{preset.manufacturer}</dd>
          </div>
          <div>
            <dt>모델명</dt>
            <dd>{preset.label}</dd>
          </div>
          <div>
            <dt>정격출력</dt>
            <dd>{preset.module_power_w} W</dd>
          </div>
          <div>
            <dt>크기 (가로×세로)</dt>
            <dd>
              {num(preset.module_width_m * 1000, 0)} × {num(preset.module_height_m * 1000, 0)} mm
              {preset.thickness_mm != null && <> · 두께 {preset.thickness_mm} mm</>}
            </dd>
          </div>
          <div>
            <dt>단가</dt>
            <dd>
              {num(preset.module_price, 0)}원/장 <small>({preset.price_source})</small>
            </dd>
          </div>
          <div className="wide">
            <dt>자료 출처</dt>
            <dd>
              {preset.source_url ? (
                <a href={preset.source_url} target="_blank" rel="noopener noreferrer">
                  {preset.source}
                </a>
              ) : (
                preset.source
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <Fields
          fields={customModuleFields}
          values={eq}
          onChange={(k, v) => onChange({ ...eq, [k]: v })}
        />
      )}
      {preset?.missing_electrical?.length ? <>
        <p className="inline-warning">Vmp·Voc·전압 온도계수{preset.gamma_pdc == null ? "·출력 온도계수" : ""} 미제공: 아래 고급 입력의 값은 계산 가정입니다. 이 제품의 확인된 제원과 구분해 수정하세요. 무게·허용하중·수상 적용성도 미확인입니다.</p>
        {preset.gamma_pdc != null && <p className="hint">제공된 출력 온도계수: {num(preset.gamma_pdc * 100, 3)} %/°C</p>}
      </> : null}
    </div>
  );
}

function InverterPicker({ equipment, inverters, onChange }: {
  equipment: Settings; inverters: CatalogInverter[]; onChange: (equipment: Settings) => void;
}) {
  const selected = inverters.find((i) => i.id === equipment.inverter_model);
  return <div className="module-picker">
    <label className="field full"><span>인버터 기종</span>
      <select aria-label="인버터 기종" value={String(equipment.inverter_model || "guideline")}
        onChange={(e) => onChange({ ...equipment, inverter_model: e.target.value })}>
        <option value="guideline">가이드라인 100·500·1,000 kW 조합</option>
        {inverters.map((i) => <option key={i.id} value={i.id}>{i.manufacturer} · {i.model} · {i.kw} kW</option>)}
      </select>
    </label>
    {selected && <>
      <dl className="module-spec">
        <div><dt>정격 출력</dt><dd>{selected.rating || `${selected.kw} kW`}</dd></div>
        <div><dt>MPPT / DC 입력</dt><dd>{selected.mppt} / {selected.channels}채널 · 외부 접속반 필요</dd></div>
        <div><dt>최대 / 유로효율</dt><dd>{selected.max_efficiency_pct}% {selected.max_efficiency_qualifier} / 유로효율 미확인</dd></div>
        <div><dt>인증서 효율</dt><dd>{selected.certified_efficiency_pct}% (유로효율로 사용 안 함)</dd></div>
        <div><dt>최대 DC 전압</dt><dd>{num(selected.max_dc_voltage_v)} V</dd></div>
        <div><dt>MPPT 동작 / 정격출력</dt><dd>{selected.mppt_min_v}~{selected.mppt_max_v} V / {selected.full_power_mppt_min_v}~{selected.mppt_max_v} V</dd></div>
        <div><dt>기동 / 정격 DC 전압</dt><dd>{selected.startup_voltage_v} / {selected.nominal_dc_voltage_v} V</dd></div>
        <div><dt>최대 입력 / 단락전류</dt><dd>{selected.max_input_current_a} / {selected.max_short_circuit_current_a} A (MPPT당)</dd></div>
        <div><dt>최대 DC 입력전력</dt><dd>{num(selected.max_dc_input_power_w)} W · 허용 어레이 kWp 미확인</dd></div>
        <div><dt>최대 AC 전류</dt><dd>{selected.max_ac_current_a} A</dd></div>
        <div><dt>크기 / 무게</dt><dd>{selected.size_mm} mm / {selected.weight_kg} kg</dd></div>
        <div><dt>단가 (가정)</dt><dd>{num(selected.unit_cost)}원/대</dd></div>
        <div className="wide"><dt>출처</dt><dd>{selected.source}</dd></div>
      </dl>
      <p className="hint">유로효율이 없어 고급 입력의 계산용 효율을 사용합니다. 초기 96%는 가정이며 인증서 97.61%와 다릅니다. {selected.price_basis}</p>
      {selected.warnings?.map((warning) => <p className="inline-warning" key={warning}>{warning}</p>)}
    </>}
  </div>;
}

function AngleReadout({ ctx, eq }: { ctx: DesignContext; eq: Settings }) {
  if (!ctx.angles?.rows?.length) {
    return (
      <p className="hint">
        분석을 한 번 실행하면 경사각·방위각을 바꿀 때 예상 발전량이 얼마나 달라지는지 여기서 바로 비교할 수 있습니다.
        (3단계에 전체 비교표가 나옵니다)
      </p>
    );
  }
  const tilt = eq.tilt_mode === "manual" ? Number(eq.tilt) : (ctx.analysedTilt ?? ctx.angles.selected.tilt);
  const azimuth = Number(eq.azimuth);
  const est = estimateAngle(ctx.angles.rows, tilt, azimuth);
  const base = ctx.angles.rows.find((r) => r.selected);
  if (!est || !base) return null;
  const diff = (est.ratio - 1) * 100;
  return (
    <div className="angle-readout">
      <span>
        경사 {num(tilt, 0)}° · 방위 {num(azimuth, 0)}° 선택 시 예상 연간 발전량
      </span>
      <strong>
        {num(est.annual_kwh / 1000, 1)} <small>MWh</small>
      </strong>
      <span className={diff > 0.05 ? "up" : diff < -0.05 ? "down" : "muted"}>
        분석 조건(경사 {num(ctx.angles.selected.tilt, 0)}° · 방위 {num(ctx.angles.selected.azimuth, 0)}°) 대비{" "}
        {diff >= 0 ? "+" : ""}
        {num(diff, 1)}%
      </span>
      <small className="muted">
        같은 30년 기상의 경사면 일사량으로 환산한 추정값입니다. 저장하고 다시 분석하면 정확한 값이 계산됩니다.
      </small>
    </div>
  );
}

export function DesignEditor({
  design,
  onChange,
  onSave,
  dirty,
  saving,
  context = {},
}: {
  design: Design;
  onChange: (d: Design) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  context?: DesignContext;
}) {
  const [tab, setTab] = useState<Tab>("equipment");
  const eq = design.equipment;
  const siteType = context.candidate?.site_type ?? "floating";
  const moduleSpec = context.modules?.find((m) => m.id === eq.module_preset);
  const checkedElectricalFields = electricalFields.map((field) => {
    if (moduleSpec?.missing_electrical && ["vmp_v", "voc_v", "voltage_temp_coeff_pct", "gamma_pdc"].includes(field.key)) {
      return { ...field, show: () => moduleSpec.missing_electrical!.includes(field.key), source: "미제공 · 계산 가정" };
    }
    if (field.key === "inverter_efficiency" && eq.inverter_model === "dass_dsp_33125kshk_nj1") {
      return { ...field, label: "계산용 인버터 효율 · 유로효율 미확인", source: "사용자 가정" };
    }
    return field;
  });
  const setGroup = (key: "equipment" | "costs" | "finance", k: string, v: unknown) =>
    onChange({
      ...design,
      [key]: { ...design[key], [k]: k === "stress_pcts" || k === "price_scenarios" ? parseStress(v) : v },
    });
  const modes = MODE_OPTIONS.concat(
    eq.capacity_mode === "area" ? [["area", "후보지 경계 면적 × 이용률", "지도에 그린 경계 면적으로 계산합니다."]] : [],
  );
  const mode = modes.find((m) => m[0] === eq.capacity_mode) ?? modes[2];
  return (
    <aside className="card inspector">
      <div className="card-heading">
        <h3>설계 조건</h3>
        <span className={"save-state " + (dirty ? "dirty" : "")}>{dirty ? "저장 안 됨" : "저장됨"}</span>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ["equipment", "② 설비·용량"],
            ["angles", "③ 각도·방향"],
            ["costs", "④ 공사비"],
            ["finance", "⑤⑥ 수익·재무"],
          ] as const
        ).map(([k, l]) => (
          <button role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} key={k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        <label className="field">
          <span>대안 이름</span>
          <input aria-label="대안 이름" value={design.name} onChange={(e) => onChange({ ...design, name: e.target.value })} />
        </label>

        {tab === "equipment" && (
          <>
            <ModulePicker
              design={design}
              modules={context.modules ?? []}
              onChange={(equipment) => onChange({ ...design, equipment })}
            />
            <fieldset className="mode-picker">
              <legend>설비 용량 입력 방식</legend>
              <div className="segmented-options">
                {modes.map(([value, label]) => (
                  <label key={value} className={eq.capacity_mode === value ? "on" : ""}>
                    <input
                      type="radio"
                      name="capacity_mode"
                      value={value}
                      checked={eq.capacity_mode === value}
                      onChange={() => setGroup("equipment", "capacity_mode", value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="hint">{mode[2]}</p>
              {eq.capacity_mode === "site_area" && (
                <Fields
                  fields={[
                    { key: "site_area_m2", label: "부지 면적", unit: "m²", step: 10 },
                    { key: "reserve_pct", label: "여유 면적 (통로·유지보수·외곽 이격)", unit: "%", step: 1, source: "데모 가정" },
                  ]}
                  values={eq}
                  onChange={(k, v) => setGroup("equipment", k, v)}
                />
              )}
              {eq.capacity_mode === "capacity" && (
                <Fields
                  fields={[{ key: "target_capacity_kw", label: "원하는 총 설비용량", unit: "kW", step: 10 }]}
                  values={eq}
                  onChange={(k, v) => setGroup("equipment", k, v)}
                />
              )}
              {eq.capacity_mode === "count" && (
                <Fields
                  fields={[{ key: "module_count", label: "모듈 수량", unit: "장" }]}
                  values={eq}
                  onChange={(k, v) => setGroup("equipment", k, v)}
                />
              )}
              {eq.capacity_mode === "area" && (
                <Fields
                  fields={[{ key: "area_use_pct", label: "경계 면적 이용률", unit: "%", step: 0.1 }]}
                  values={eq}
                  onChange={(k, v) => setGroup("equipment", k, v)}
                />
              )}
              <CapacityPreview design={design} candidate={context.candidate} />
            </fieldset>
            <Fields fields={layoutFields} values={eq} onChange={(k, v) => setGroup("equipment", k, v)} />
            <InverterPicker equipment={eq} inverters={context.inverters ?? []} onChange={(equipment) => onChange({ ...design, equipment })} />
            <details className="advanced">
              <summary>전기 사양·발전량 모델 (고급)</summary>
              <Fields fields={checkedElectricalFields} values={eq} onChange={(k, v) => setGroup("equipment", k, v)} />
            </details>
          </>
        )}

        {tab === "angles" && (
          <>
            <Fields fields={angleFields} values={eq} onChange={(k, v) => setGroup("equipment", k, v)} />
            <AngleReadout ctx={context} eq={eq} />
            <p className="hint">
              태양 위치는 시간과 계절에 따라 바뀌므로 한 각도가 늘 최적인 것은 아닙니다. 조건별 예상 발전량을 비교해 고르세요.
              음영 손실은 주변 건물·산·나무 그늘로 줄어드는 비율을 가정해 입력합니다.
            </p>
          </>
        )}

        {tab === "costs" && (
          <>
            <Fields
              fields={costs}
              values={{ module_unit_price: 0, inverter_unit_price: 0, ...design.costs, site_type: siteType, inverter_model: eq.inverter_model || "guideline" }}
              onChange={(k, v) => setGroup("costs", k, v)}
            />
            <p className="hint">
              모듈(카탈로그·표 3-9)·인버터(표 3-12) 단가는 자동 반영됩니다. ‘견적 가정’ 항목은 실제 견적으로 바꾸세요. 부유체·계류장치는
              설치장소 유형이 ‘수상’일 때만 계산에 들어갑니다.
            </p>
          </>
        )}

        {tab === "finance" && (
          <>
            {context.requiredPrice != null && (
              <div className="price-reference">
                참고 · 최근 분석의 최소 필요 판매단가 <strong>{num(context.requiredPrice, 1)}원/kWh</strong>
                <small>(B/C = 1이 되는 단가, 입력값에는 제한이 없습니다)</small>
              </div>
            )}
            <Fields
              fields={finance}
              values={{
                ...(design.finance as Settings),
                stress_pcts: listText(design.finance.stress_pcts),
                price_scenarios: listText(design.finance.price_scenarios ?? []),
                purpose: eq.purpose,
              }}
              onChange={(k, v) => setGroup("finance", k, v)}
            />
            <p className="hint">
              신규 후보지는 판매 실적이 없으므로 현금 유입 = 예측 발전량 × 판매단가로 계산합니다. B/C = 유입 현재가치 ÷ 유출 현재가치.
            </p>
          </>
        )}
      </div>
      <div className="inspector-footer">
        <button className={"btn block " + (dirty ? "primary" : "")} disabled={saving || !dirty} onClick={onSave}>
          {saving ? "저장 중…" : dirty ? "조건 저장" : "저장된 상태입니다"}
        </button>
      </div>
    </aside>
  );
}
export function CandidateForm({
  candidate,
  onSubmit,
}: {
  candidate: Candidate;
  onSubmit: (candidate: Candidate) => void;
}) {
  const [value, setValue] = useState(candidate);
  const fields: FieldDef[] = [
    {
      key: "site_type",
      label: "설치장소 유형",
      options: [
        ...SITE_TYPE_OPTIONS.map((o) => [o.value, o.label] as [string, string]),
        ["plant", "정수장 부지 (K-water 시설)"],
        ["basin", "침전지 상부 (K-water 시설)"],
      ],
    },
    { key: "latitude", label: "위도", step: 0.00001 },
    { key: "longitude", label: "경도", step: 0.00001 },
    {
      key: "cable_distance_m",
      required: false,
      label: "한전 접속점 연계거리",
      unit: "m",
      step: 0.1,
    },
    {
      key: "water_depth_m",
      required: false,
      label: "수심 · 별도 조사값",
      unit: "m",
      step: 0.1,
    },
    {
      key: "water_level_m",
      required: false,
      label: "수위 · 별도 조사값",
      unit: "m",
      step: 0.1,
    },
  ];
  const shift = (poly: { type: "Polygon"; coordinates: number[][][] }, k: string, delta: number) => ({
    ...poly,
    coordinates: poly.coordinates.map((r) =>
      r.map((p) => [
        p[0] + (k === "longitude" ? delta : 0),
        p[1] + (k === "latitude" ? delta : 0),
      ]),
    ),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label className="field">
        <span>후보지 이름</span>
        <input
          required
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </label>
      <Fields
        fields={fields}
        values={Object.fromEntries(
          fields.map((f) => [
            f.key,
            (value as unknown as Settings)[f.key] ?? "",
          ]),
        )}
        onChange={(k, v) => {
          const next = { ...value, [k]: v === "" ? null : v };
          if (k === "latitude" || k === "longitude") {
            const delta = Number(v) - Number((value as unknown as Settings)[k]);
            next.geometry = value.geometry && shift(value.geometry, k, delta);
            next.exclusions = value.exclusions.map((poly) => shift(poly, k, delta));
          }
          setValue(next);
        }}
      />
      {value.source && <p className="hint">출처: {value.source}</p>}
      <p className="hint">
        비워 둔 수심·수위·거리는 ‘미확인’으로 저장됩니다. 좌표를 바꾸면 경계도
        함께 이동합니다.
      </p>
      <button className="btn primary block" type="submit">
        후보지 저장
      </button>
    </form>
  );
}
