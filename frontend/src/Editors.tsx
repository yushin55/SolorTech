import { useState } from "react";
import type { Candidate, Catalog, CatalogInverter, CatalogModule, Design, Settings, TerrainMode } from "./types";
import { num } from "./api";
import { CandidateWeather, CapacityPreview } from "./Feasibility";
export type FieldDef = {
  key: string;
  label: string;
  unit?: string;
  required?: boolean;
  step?: number;
  options?: [string, string][];
  /** Field is shown only when this returns true for the current values. */
  show?: (values: Settings) => boolean;
  /** Short provenance badge, e.g. the guideline table or "견적 가정". */
  source?: string;
  text?: boolean;
  disabled?: boolean;
};
const custom = (v: Settings) => v.module_preset === "custom";
const guidelineInverter = (v: Settings) => !v.inverter_model || v.inverter_model === "guideline";
/** Catalog modules carry datasheet Vmp/Voc/temperature coefficients, so those inputs are hidden. */
const manualElectrical = (v: Settings) =>
  ["floating_450", "land_480", "custom"].includes(String(v.module_preset));
// ① 설치대상지 선정 (가이드라인 부록 2.2)
const site: FieldDef[] = [
  {
    key: "structure_type",
    label: "구조물 형식",
    options: [
      ["fixed", "고정형 (최적경사각 고정)"],
      ["seasonal", "가변형 (계절별 경사각 조정)"],
    ],
    source: "표 3-17",
  },
  {
    key: "tilt_mode",
    label: "경사각 결정",
    options: [
      ["guideline", "가이드라인 지역별 최적경사각 자동"],
      ["manual", "직접 입력"],
    ],
    show: (v) => v.structure_type !== "seasonal",
    source: "표 3-18·3-19",
  },
  {
    key: "tilt",
    label: "경사각",
    unit: "°",
    show: (v) => v.tilt_mode === "manual" && v.structure_type !== "seasonal",
  },
  { key: "azimuth", label: "방위각 · 정남 180°", unit: "°", source: "3.5.1" },
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
// ② 부지면적 및 기자재 기술사양 (부록 2.3)
const equipment: FieldDef[] = [
  {
    key: "module_preset",
    label: "모듈",
    options: [
      ["floating_450", "가이드라인 수상용 450 Wp · 225,000원/장"],
      ["land_480", "가이드라인 육상용 480 Wp · 230,400원/장"],
      ["hd_his_t650uj", "HD현대 UJ HiS-T650UJ-ES · 650 Wp 수상용 TOPCon"],
      ["custom", "직접 입력"],
    ],
    source: "표 3-9 · 제조사 카탈로그",
  },
  { key: "module_model", label: "모듈 모델명", text: true, show: custom },
  { key: "module_manufacturer", label: "모듈 제조사", text: true, show: custom },
  { key: "module_source", label: "모듈 자료 출처 · 공식 카탈로그 등", text: true, show: custom },
  { key: "module_power_w", label: "모듈 정격출력", unit: "W", step: 5, show: custom },
  { key: "module_width_m", label: "모듈 폭", unit: "m", step: 0.001, show: custom },
  { key: "module_height_m", label: "모듈 길이", unit: "m", step: 0.001, show: custom },
  { key: "module_price", label: "모듈 단가", unit: "원/장", show: custom },
  {
    key: "capacity_mode",
    label: "설치 용량 결정",
    options: [
      ["area_input", "부지 면적 직접 입력"],
      ["target", "원하는 총 설비용량 입력"],
      ["count", "모듈 수량 입력"],
      ["area", "지도 경계 면적 × 이용률 (기존 방식)"],
    ],
    source: "부록 2.4",
  },
  {
    key: "module_count",
    label: "모듈 수량",
    unit: "장",
    show: (v) => v.capacity_mode === "count",
  },
  { key: "site_area_m2", label: "부지 면적", unit: "m²", step: 0.1, show: (v) => v.capacity_mode === "area_input" },
  { key: "reserve_pct", label: "통로·장애물 여유 면적", unit: "%", step: 0.1, source: "견적 가정", show: (v) => v.capacity_mode === "area_input" },
  { key: "target_capacity_kw", label: "원하는 총 설비용량", unit: "kW", step: 0.001, show: (v) => v.capacity_mode === "target" },
  { key: "float_model", label: "부유체 모델·제원명", text: true },
  { key: "float_buoyancy_kg", label: "부유체 단위 부력 · 참고 제원", unit: "kg", required: false },
  { key: "float_source", label: "부유체 제원 출처", text: true },
  { key: "mooring_model", label: "계류장치 모델·제원명", text: true },
  { key: "mooring_design_load_kn", label: "계류 설계하중 · 참고 제원", unit: "kN", required: false },
  { key: "mooring_source", label: "계류장치 제원 출처", text: true },
  {
    key: "area_use_pct",
    label: "수면 이용률",
    unit: "%",
    step: 0.1,
    show: (v) => v.capacity_mode === "area",
  },
  { key: "array_rows", label: "어레이 세로 단수", unit: "단", source: "표 3-15" },
  {
    key: "spacing_mode",
    label: "어레이 이격거리",
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
    key: "vmp_v",
    label: "모듈 최대전압 Vmp",
    unit: "V",
    step: 0.01,
    source: "표 3-13",
    show: manualElectrical,
  },
  {
    key: "voc_v",
    label: "모듈 개방전압 Voc",
    unit: "V",
    step: 0.01,
    source: "표 3-13",
    show: manualElectrical,
  },
  {
    key: "voltage_temp_coeff_pct",
    label: "전압 온도계수",
    unit: "%/°C",
    step: 0.01,
    show: manualElectrical,
  },
  {
    key: "inverter_model",
    label: "인버터 기종",
    options: [
      ["guideline", "가이드라인 100·500·1,000 kW 조합"],
      ["qvolt_p60ta", "한화큐셀 Q.VOLT P60TA · 60 kVA"],
      ["qvolt_p110ta", "한화큐셀 Q.VOLT P110TA · 110 kVA"],
      ["qvolt_p125tx", "한화큐셀 Q.VOLT P125T-X · 125 kVA"],
      ["hd_h125", "HD현대 H125 · 125 kW"],
      ["hd_h150", "HD현대 H150 · 150 kW"],
      ["hd_h350", "HD현대 H350 · 350 kW"],
    ],
    source: "표 3-12 · 제조사 카탈로그",
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
  {
    key: "energy_basis",
    label: "사업성에 쓸 발전량",
    options: [
      ["calibrated", "운영실적 보정값 (장소 분리 검증 모델)"],
      ["physics", "물리 모델 단독 (pvlib)"],
    ],
  },
  { key: "system_loss_pct", label: "시스템 손실률 · 물리 모델", unit: "%", step: 0.1 },
  {
    key: "inverter_efficiency",
    label: "인버터 효율 · 물리 모델",
    unit: "0–1",
    step: 0.01,
    show: guidelineInverter,
  },
  {
    key: "gamma_pdc",
    label: "출력 온도계수 · 물리 모델",
    unit: "/°C",
    step: 0.0001,
    show: manualElectrical,
  },
];
// ④ 개략공사비 (부록 2.5) — module and inverter prices come from the guideline.
const costs: FieldDef[] = [
  { key: "module_unit_price", label: "모듈 견적 단가 (0 = 가이드라인·환산 단가)", unit: "원/장", source: "견적" },
  {
    key: "inverter_unit_price",
    label: "인버터 견적 단가 (0 = 환산 단가)",
    unit: "원/대",
    source: "견적",
    show: (v) => !guidelineInverter(v),
  },
  { key: "float_per_kw", label: "부유체", unit: "원/kW", source: "견적 가정" },
  { key: "mooring_per_kw", label: "계류장치", unit: "원/kW", source: "견적 가정" },
  { key: "structure_per_kw", label: "구조물 (지상·침전지)", unit: "원/kW", source: "견적 가정" },
  { key: "electrical_per_kw", label: "전기공사·기타 자재", unit: "원/kW", source: "견적 가정" },
  { key: "junction_box_unit", label: "접속반 단가 (0 = 전기공사 포함)", unit: "원/면", source: "견적 가정" },
  { key: "cable_per_m", label: "수중·연계 케이블", unit: "원/m", source: "견적 가정" },
  { key: "civil", label: "토목공사 총액", unit: "원", source: "견적 가정" },
  { key: "design_permitting", label: "설계·인허가 총액", unit: "원", source: "견적 가정" },
  { key: "grid_connection", label: "계통연계(한전) 총액", unit: "원", source: "견적 가정" },
  { key: "annual_om_per_kw", label: "연간 유지관리비", unit: "원/kW·년", source: "견적 가정" },
  { key: "replacement_year", label: "인버터 교체 연차", unit: "년차" },
];
// ⑤ 예상수익 (부록 2.6)
const revenue: FieldDef[] = [
  {
    key: "sale_mode",
    label: "판매 단가 방식",
    options: [
      ["fixed", "장기 고정가격 계약 (경쟁입찰)"],
      ["smp_rec", "SMP + REC"],
    ],
    source: "부록 2.6",
  },
  { key: "fixed_price", label: "계약 단가", unit: "원/kWh", step: 0.1, source: "사용자 가정", show: (v) => v.sale_mode === "fixed" },
  { key: "price_source", label: "판매단가 가정 출처", text: true },
  { key: "price_scenarios", label: "비교 판매단가 · 쉼표 구분 (원/kWh)", text: true },
  { key: "smp_price", label: "SMP", unit: "원/kWh", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_price", label: "REC 가격", unit: "원/REC", show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_weight", label: "REC 가중치 (고시 확인)", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "self_use_kwh", label: "연간 소내 소비전력량", unit: "kWh", show: (v) => v.purpose === "self" },
  { key: "retail_price", label: "소내 사용 전력 단가", unit: "원/kWh", step: 0.1, show: (v) => v.purpose === "self" },
  { key: "curtailment_pct", label: "출력제한 가정", unit: "%", step: 0.1 },
];
// ⑥ 재무성 분석 (부록 2.7)
const finance: FieldDef[] = [
  { key: "years", label: "사업기간", unit: "년" },
  { key: "discount_pct", label: "할인율", unit: "%", step: 0.1 },
  { key: "degradation_pct", label: "연간 열화율", unit: "%", step: 0.1 },
  { key: "stress_pcts", label: "발전량 감소 점검", unit: "%, 쉼표 구분", text: true },
  { key: "loan_pct", label: "융자 비율 (0 = 전액 자기자본)", unit: "%", step: 1, source: "자금 조달", required: false },
  { key: "loan_rate_pct", label: "융자 이자율", unit: "%/년", step: 0.1, show: (v) => Number(v.loan_pct) > 0, source: "자금 조달" },
  { key: "loan_years", label: "상환 기간 (거치 후)", unit: "년", show: (v) => Number(v.loan_pct) > 0, source: "자금 조달" },
  { key: "grace_years", label: "거치 기간 (이자만 납부)", unit: "년", show: (v) => Number(v.loan_pct) > 0, source: "자금 조달" },
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
        .map((f) => (
          <label
            className={"field" + (f.options || f.text ? " full" : "")}
            key={f.key}
          >
            <span>
              {f.label}
              {f.source && (
                <em
                  className={
                    "field-source" + (f.source === "견적 가정" ? " assumed" : "")
                  }
                >
                  {f.source}
                </em>
              )}
            </span>
            {f.options ? (
              <select
                disabled={f.disabled}
                aria-label={f.label}
                value={values[f.key]}
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
                  disabled={f.disabled}
                  aria-label={f.label}
                  required={f.required !== false}
                  type={f.text ? "text" : "number"}
                  step={f.step || 1}
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    onChange(
                      f.key,
                      f.text
                        ? e.target.value
                        : e.target.value === ""
                          ? ""
                          : Number(e.target.value),
                    )
                  }
                />
                {f.unit && <small>{f.unit}</small>}
              </div>
            )}
          </label>
        ))}
    </div>
  );
}
const stressText = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : String(value ?? "");
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
/** Product photo cropped from the manufacturer product page (public/catalog). */
export const productImage = (id: string) => `${import.meta.env.BASE_URL}catalog/${id}.webp`;
function Spec({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
/** Manufacturer datasheet values for the selected catalog module / inverter. */
function CatalogSpecs({ module, inverter }: { module?: CatalogModule; inverter?: CatalogInverter }) {
  if (!module?.manufacturer && !inverter) return null;
  return (
    <div className="catalog-specs">
      {module?.manufacturer && (
        <article className="catalog-card">
          <img className="catalog-photo" src={productImage(module.id)} alt={`${module.series} 제품 사진`} />
          <header>
            <small>{module.manufacturer} · 모듈</small>
            <strong>{module.series}</strong>
          </header>
          <dl>
            <Spec label="출력" value={`${num(module.module_power_w)} Wp`} />
            <Spec label="효율" value={module.efficiency_pct && `${module.efficiency_pct}%`} />
            <Spec
              label="크기"
              value={`${num(module.module_height_m * 1000)} × ${num(module.module_width_m * 1000)} × ${module.thickness_mm} mm`}
            />
            <Spec label="무게" value={module.weight_kg && `${module.weight_kg} kg`} />
            <Spec label="풍설하중" value={module.load_pa} />
            <Spec label="Vmp / Voc" value={module.vmp_v && `${module.vmp_v} / ${module.voc_v} V`} />
            <Spec label="Imp / Isc" value={module.imp_a && `${module.imp_a} / ${module.isc_a} A`} />
            <Spec
              label="온도계수"
              value={
                module.gamma_pdc &&
                `Pmax ${num(module.gamma_pdc * 100, 2)} · Voc ${module.voltage_temp_coeff_pct} %/°C`
              }
            />
            <Spec label="동작온도" value={module.noct} />
            <Spec label="품질보증" value={module.warranty} />
            <Spec label="적용 단가" value={`${num(module.module_price)}원/장`} />
          </dl>
          {module.features && (
            <ul className="catalog-tags">
              {module.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <p className="catalog-note">
            전압·온도계수는 데이터시트 값이 직렬 수(표 3-13)와 물리 모델에 자동 적용됩니다.
            {module.floating === false && " 제조사 수상용 표기가 없는 모델이므로 수상 적용성(내습·PID)을 확인하세요."}
            <br />
            <em className="field-source assumed">견적 가정</em> {module.price_basis}. 견적을 받으면 ④단계
            ‘모듈 견적 단가’에 입력하세요.
          </p>
          <p className="catalog-credit">출처: {module.source}</p>
        </article>
      )}
      {inverter && (
        <article className="catalog-card">
          <img className="catalog-photo" src={productImage(inverter.id)} alt={`${inverter.model} 제품 사진`} />
          <header>
            <small>{inverter.manufacturer} · 인버터</small>
            <strong>{inverter.model}</strong>
          </header>
          <dl>
            <Spec
              label="정격 / 최대출력"
              value={inverter.max_kva ? `${inverter.kw} / ${inverter.max_kva} kVA` : inverter.rating}
            />
            <Spec
              label="최대 / 유로효율"
              value={`${inverter.max_efficiency_pct} / ${inverter.euro_efficiency_pct}%`}
            />
            <Spec
              label="MPPT / 채널"
              value={inverter.channels ? `${inverter.mppt} / ${inverter.channels}` : `${inverter.mppt} MPPT`}
            />
            <Spec label="퓨즈용량" value={inverter.fuse_a && `${inverter.fuse_a} A`} />
            <Spec label="무게" value={`${inverter.weight_kg} kg`} />
            <Spec label="크기" value={`${inverter.size_mm} mm`} />
            <Spec label="품질보증" value={inverter.warranty} />
            <Spec label="적용 단가" value={`${num(inverter.unit_cost)}원/대`} />
          </dl>
          <ul className="catalog-tags">
            {inverter.features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="catalog-note">
            <em className="field-source assumed">견적 가정</em> {inverter.price_basis}. 견적은 ④단계
            ‘인버터 견적 단가’에 입력하세요. 물리 모델 효율은 유로효율 {inverter.euro_efficiency_pct}%를 씁니다.
          </p>
        </article>
      )}
      <p className="catalog-credit">제품 사진·제원: 각 제조사 제품 페이지·데이터시트</p>
    </div>
  );
}
export type Section = "site" | "equipment" | "costs" | "revenue" | "finance";
const sections: Record<
  Section,
  { title: string; fields: FieldDef[]; key: "equipment" | "costs" | "finance"; hint: string }
> = {
  site: {
    title: "구조물·경사각 (①)",
    fields: site,
    key: "equipment",
    hint: "경사각은 후보지 위치로 가이드라인 표 3-19(50 km 이내 K-water 정수장) 또는 표 3-18에서 정합니다. 풍속·적설·지진 계수는 ①단계 산정 결과에 표시됩니다.",
  },
  equipment: {
    title: "기자재 기술사양 (②)",
    fields: equipment,
    key: "equipment",
    hint: "직렬 수(표 3-13)·인버터 구성(표 3-12)·접속반(표 3-14)은 자동 산정됩니다. 물리 모델 항목은 ‘물리 모델 단독’ 결과에만 쓰이며, 보정값에는 실제 손실이 이미 반영되어 있습니다.",
  },
  costs: {
    title: "공사비 단가 (④)",
    fields: costs,
    key: "costs",
    hint: "모듈(표 3-9)·인버터(표 3-12) 단가는 가이드라인 값으로 자동 반영되고, 제조사 카탈로그 기종은 가격이 공개되지 않아 같은 표의 W·kW당 단가로 환산합니다. 견적 단가를 넣으면 그 값이 우선합니다. ‘견적 가정’ 항목은 가이드라인에 없으므로 실제 견적으로 바꾸세요.",
  },
  revenue: {
    title: "판매 조건 (⑤)",
    fields: revenue,
    key: "finance",
    hint: "매출은 예측 판매전력량 × 사용자 판매단가입니다. 실제 판매실적이 아니며, 판매단가·비교단가에는 상하한 제한이 없습니다. 최소 필요 판매단가는 SolarTech 계산 참고값입니다. 자가소비는 사용분을 전기요금 단가로 환산합니다.",
  },
  finance: {
    title: "재무 조건 (⑥)",
    fields: finance,
    key: "finance",
    hint: "B/C = 유입 현재가치 ÷ 유출 현재가치. 필요 판매단가는 B/C = 1이 되는 단가(= 균등화발전원가 LCOE)로, 입찰가가 아닌 후보지 비교 참고값입니다. 융자 조건은 선택 입력이며 자기자본 수익률·원리금 상환 능력(DSCR)만 따로 보여 주고, B/C·NPV는 가이드라인대로 비차입 기준을 유지합니다.",
  },
};
/** Design inputs for the given guideline steps of the review wizard. */
export function DesignEditor({
  design,
  show,
  onChange,
  onSave,
  dirty,
  saving,
  catalog,
  candidate,
}: {
  design: Design;
  show: Section[];
  catalog?: Catalog | null;
  candidate?: Candidate | null;
  onChange: (d: Design) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
}) {
  const eq = design.equipment;
  const land = !!candidate && candidate.site_type !== "floating";
  const dedicated = candidate?.site_type === "land" || candidate?.site_type === "rooftop";
  const flush = candidate?.site_type === "rooftop" && candidate.roof_mount === "flush";
  function terrainFields(fields: FieldDef[]): FieldDef[] {
    return fields.filter((f) => !(flush && ["structure_type", "tilt_mode", "tilt", "azimuth", "spacing_mode", "row_spacing_m"].includes(f.key)))
      .map((f) => {
        if (land && (f.key.startsWith("float_") || f.key.startsWith("mooring_"))) return { ...f, disabled: true };
        if (!land) return f;
        if (f.key === "energy_basis" && dedicated) return { ...f, options: [["physics", "물리 모델 (육상·건축물 조건 반영)"]] };
        if (f.key === "area_use_pct") return { ...f, label: "유효 부지·지붕 이용률" };
        if (f.key === "tilt_mode" && dedicated) return { ...f, source: "예비설계 가정", options: [["guideline", "위도 기반 예비 경사각 자동"], ["manual", "직접 입력"]] };
        if (f.key === "structure_per_kw") return { ...f, label: "가대·기초·건축물 구조물" };
        if (f.key === "cable_per_m") return { ...f, label: "육상·건축물 연계 케이블" };
        if (f.key === "civil" && candidate?.site_type === "rooftop") return { ...f, label: "건축·방수·보강 공사 총액" };
        return f;
      });
  }
  const catalogModule = catalog?.modules.find((m) => m.id === eq.module_preset);
  const catalogInverter = catalog?.inverters?.find((i) => i.id === eq.inverter_model);
  return (
    <section className="card inspector">
      <div className="card-heading">
        <h3>설계 조건 입력</h3>
        <span className={"save-state " + (dirty ? "dirty" : "")}>
          {dirty ? "저장 안 됨" : "저장됨"}
        </span>
      </div>
      <div className="inspector-body">
        {show.includes("equipment") && (
          <label className="field">
            <span>대안 이름</span>
            <input
              aria-label="대안 이름"
              value={design.name}
              onChange={(e) => onChange({ ...design, name: e.target.value })}
            />
          </label>
        )}
        {show.map((s) => {
          const group = sections[s];
          const values: Settings =
            group.key === "finance"
              ? {
                  // Designs saved before 자금 조달 existed show the server defaults.
                  loan_pct: 0,
                  loan_rate_pct: 4.5,
                  loan_years: 10,
                  grace_years: 0,
                  ...(design.finance as Settings),
                  stress_pcts: stressText(design.finance.stress_pcts),
                  price_scenarios: stressText(design.finance.price_scenarios ?? [100, 150, 200]),
                  purpose: eq.purpose,
                }
              : group.key === "costs"
                ? { ...design.costs, inverter_model: eq.inverter_model }
                : { site_area_m2: 10000, target_capacity_kw: 100, reserve_pct: 20,
                    module_manufacturer: "미지정 (가이드라인 예시)", module_source: "K-water 표 3-9",
                    float_model: "사용자 제원 미입력", float_source: "사용자 조사·견적 가정", float_buoyancy_kg: 0,
                    mooring_model: "사용자 제원 미입력", mooring_source: "사용자 조사·견적 가정", mooring_design_load_kn: 0,
                    ...design[group.key] };
          return (
            <div className="inspector-section" key={s}>
              <h4>{group.title}</h4>
              {s === "equipment" && eq.capacity_mode === "count" && (
                <div className="capacity">
                  <span>입력 DC 용량 (직렬 단위 조정 전)</span>
                  <strong>
                    {num(
                      (Number(eq.module_count) *
                        Number(
                          eq.module_preset === "custom"
                            ? eq.module_power_w
                            : (catalogModule?.module_power_w ?? eq.module_power_w),
                        )) /
                        1000,
                      1,
                    )}{" "}
                    kW
                  </strong>
                </div>
              )}
              <Fields
                fields={terrainFields(group.fields)}
                values={dedicated && group.key === "equipment" ? { ...values, energy_basis: "physics" } : values}
                onChange={(k, v) =>
                  onChange({
                    ...design,
                    [group.key]: {
                      ...design[group.key],
                      [k]: k === "stress_pcts" || k === "price_scenarios" ? parseStress(v) : v,
                    },
                  })
                }
              />
              {s === "equipment" && (
                <>
                  {candidate && <CapacityPreview candidate={candidate} equipment={eq} />}
                  <CatalogSpecs module={catalogModule} inverter={catalogInverter} />
                  <p className="hint">{land ? "부유체·계류장치 제원은 수상 선택 시 활성화됩니다." : "부유체·계류장치 제원은 참고 기록이며 부력·계류 구조 안전을 자동 판정하지 않습니다. 제품 카탈로그 확보 전에는 직접 입력합니다."}</p>
                </>
              )}
              <p className="hint">{land && s === "site" ? flush
                ? "지붕 밀착형은 후보지 설정의 지붕 경사·방위를 사용합니다. 행간은 0 m이며 통로·장애물은 제외 구역으로 지정하세요."
                : "육상·건축물은 위도 기반 예비 경사각 또는 직접 입력값을 사용합니다. 실제 지형·지붕과 구조 조건을 확인하세요."
                : land && s === "equipment" ? "육상·건축물은 물리 모델로 음영손실과 설치 방식별 온도를 반영합니다. 경계 이격·제외 구역은 후보지 설정에서 지정하며, 배치 가능한 수량으로 계산합니다."
                : group.hint}</p>
            </div>
          );
        })}
      </div>
      <div className="inspector-footer">
        <button
          className={"btn block " + (dirty ? "primary" : "")}
          disabled={saving || !dirty}
          onClick={onSave}
        >
          {saving ? "저장 중…" : dirty ? "조건 저장" : "저장된 상태입니다"}
        </button>
      </div>
    </section>
  );
}
export function CandidateForm({
  candidate,
  onSubmit,
}: {
  candidate: Candidate;
  onSubmit: (candidate: Candidate) => void;
  terrainMode?: TerrainMode;
}) {
  const [value, setValue] = useState(candidate);
  const land = value.site_type !== "floating";
  const fields: FieldDef[] = [
    {
      key: "site_type",
      label: "설치장소 유형",
      options: [
        ["floating", "수상 (댐·저수지 수면)"],
        ["plant", "정수장 부지"],
        ["basin", "침전지 상부"],
        ["land", "지상 (평지/경사지)"],
        ["rooftop", "건축물 (지붕·옥상)"],
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
      show: () => !land,
    },
    {
      key: "water_level_m",
      required: false,
      label: "수위 · 별도 조사값",
      unit: "m",
      step: 0.1,
      show: () => !land,
    },
    { key: "boundary_setback_m", label: "경계 이격 · 사용자 설계값", unit: "m", step: 0.1, show: () => land },
    { key: "shading_loss_pct", label: "추가 음영손실 · 시스템 손실과 별도", unit: "%", step: 0.1 },
    { key: "terrain_slope_deg", label: "부지 경사 · 조사값", unit: "°", step: 0.1, required: false, show: () => value.site_type === "land" },
    { key: "slope_limit_deg", label: "경사 검토 한계 · 사용자 가정", unit: "°", step: 0.1, show: () => value.site_type === "land" },
    { key: "roof_mount", label: "지붕 설치 방식", options: [["rack", "가대형 (독립 경사·방위)"], ["flush", "지붕 밀착형 (지붕 경사·방위 적용)"]], show: () => value.site_type === "rooftop" },
    { key: "roof_tilt_deg", label: "지붕 경사", unit: "°", step: 0.1, show: () => value.site_type === "rooftop" && value.roof_mount === "flush" },
    { key: "roof_azimuth_deg", label: "지붕 방위 · 정남 180°", unit: "°", step: 0.1, show: () => value.site_type === "rooftop" && value.roof_mount === "flush" },
    { key: "roof_allowable_load_kg_m2", label: "지붕 허용 추가하중 · 구조 검토값", unit: "kg/m²", step: 0.1, required: false, show: () => value.site_type === "rooftop" },
    { key: "roof_system_load_kg_m2", label: "설치 추가하중 · 모듈·가대·밸러스트", unit: "kg/m²", step: 0.1, required: false, show: () => value.site_type === "rooftop" },
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
            (value as unknown as Settings)[f.key] ?? ({ boundary_setback_m: 0, shading_loss_pct: 0, slope_limit_deg: 15,
              roof_mount: "rack", roof_tilt_deg: 10, roof_azimuth_deg: 180 } as Settings)[f.key] ?? "",
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
      <CandidateWeather candidate={value} />
      {value.source && <p className="hint">출처: {value.source}</p>}
      <p className="hint">
        {land ? "경계는 수평 투영 면적입니다. 비워 둔 조사값은 미확인으로 저장됩니다. 이격·경사 한계·하중은 사용자 설계·조사값이며 법정 기준을 자동 판정하지 않습니다. 좌표를 바꾸면 경계도 함께 이동합니다."
          : "비워 둔 수심·수위·거리는 ‘미확인’으로 저장됩니다. 좌표를 바꾸면 경계도 함께 이동합니다."}
      </p>
      <button className="btn primary block" type="submit">
        후보지 저장
      </button>
    </form>
  );
}
