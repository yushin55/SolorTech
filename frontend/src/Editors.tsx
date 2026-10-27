import { useState } from "react";
import type { Candidate, Design, Settings } from "./types";
import { num } from "./api";
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
};
const custom = (v: Settings) => v.module_preset === "custom";
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
      ["floating_450", "수상용 450 Wp · 225,000원/장"],
      ["land_480", "육상용 480 Wp · 230,400원/장"],
      ["custom", "직접 입력"],
    ],
    source: "표 3-9",
  },
  { key: "module_model", label: "모듈 모델명", text: true, show: custom },
  { key: "module_power_w", label: "모듈 정격출력", unit: "W", step: 5, show: custom },
  { key: "module_width_m", label: "모듈 폭", unit: "m", step: 0.001, show: custom },
  { key: "module_height_m", label: "모듈 길이", unit: "m", step: 0.001, show: custom },
  { key: "module_price", label: "모듈 단가", unit: "원/장", show: custom },
  {
    key: "capacity_mode",
    label: "설치 용량 결정",
    options: [
      ["count", "모듈 수량 입력"],
      ["area", "수면 면적 × 이용률 (가이드라인 이격거리)"],
    ],
    source: "부록 2.4",
  },
  {
    key: "module_count",
    label: "모듈 수량",
    unit: "장",
    show: (v) => v.capacity_mode !== "area",
  },
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
  { key: "vmp_v", label: "모듈 최대전압 Vmp", unit: "V", step: 0.01, source: "표 3-13" },
  { key: "voc_v", label: "모듈 개방전압 Voc", unit: "V", step: 0.01, source: "표 3-13" },
  {
    key: "voltage_temp_coeff_pct",
    label: "전압 온도계수",
    unit: "%/°C",
    step: 0.01,
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
  { key: "inverter_efficiency", label: "인버터 효율 · 물리 모델", unit: "0–1", step: 0.01 },
  { key: "gamma_pdc", label: "출력 온도계수 · 물리 모델", unit: "/°C", step: 0.0001 },
];
// ④ 개략공사비 (부록 2.5) — module and inverter prices come from the guideline.
const costs: FieldDef[] = [
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
// ⑤ 예상수익 · ⑥ 재무성 분석 (부록 2.6·2.7)
const finance: FieldDef[] = [
  {
    key: "sale_mode",
    label: "판매 단가 방식",
    options: [
      ["fixed", "장기 고정가격 계약 (경쟁입찰)"],
      ["smp_rec", "SMP + REC"],
    ],
    source: "부록 2.6",
  },
  { key: "fixed_price", label: "계약 단가", unit: "원/kWh", step: 0.1, show: (v) => v.sale_mode === "fixed" },
  { key: "smp_price", label: "SMP", unit: "원/kWh", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_price", label: "REC 가격", unit: "원/REC", show: (v) => v.sale_mode === "smp_rec" },
  { key: "rec_weight", label: "REC 가중치 (고시 확인)", step: 0.1, show: (v) => v.sale_mode === "smp_rec" },
  { key: "self_use_kwh", label: "연간 소내 소비전력량", unit: "kWh", show: (v) => v.purpose === "self" },
  { key: "retail_price", label: "소내 사용 전력 단가", unit: "원/kWh", step: 0.1, show: (v) => v.purpose === "self" },
  { key: "years", label: "사업기간", unit: "년" },
  { key: "discount_pct", label: "할인율", unit: "%", step: 0.1 },
  { key: "degradation_pct", label: "연간 열화율", unit: "%", step: 0.1 },
  { key: "curtailment_pct", label: "출력제한 가정", unit: "%", step: 0.1 },
  { key: "stress_pcts", label: "발전량 감소 점검", unit: "%, 쉼표 구분", text: true },
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
type Tab = "site" | "equipment" | "costs" | "finance";
export function DesignEditor({
  design,
  onChange,
  onSave,
  dirty,
  saving,
}: {
  design: Design;
  onChange: (d: Design) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
}) {
  const [tab, setTab] = useState<Tab>("site");
  const eq = design.equipment;
  const groups: Record<Tab, { fields: FieldDef[]; key: "equipment" | "costs" | "finance" }> = {
    site: { fields: site, key: "equipment" },
    equipment: { fields: equipment, key: "equipment" },
    costs: { fields: costs, key: "costs" },
    finance: { fields: finance, key: "finance" },
  };
  const group = groups[tab];
  const values: Settings =
    group.key === "finance"
      ? {
          ...(design.finance as Settings),
          stress_pcts: stressText(design.finance.stress_pcts),
          purpose: eq.purpose,
        }
      : design[group.key];
  return (
    <aside className="card inspector">
      <div className="card-heading">
        <h3>설계 조건</h3>
        <span className={"save-state " + (dirty ? "dirty" : "")}>
          {dirty ? "저장 안 됨" : "저장됨"}
        </span>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ["site", "① 대상지"],
            ["equipment", "② 기자재"],
            ["costs", "④ 공사비"],
            ["finance", "⑤⑥ 수익·재무"],
          ] as const
        ).map(([k, l]) => (
          <button
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "active" : ""}
            key={k}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        <label className="field">
          <span>대안 이름</span>
          <input
            aria-label="대안 이름"
            value={design.name}
            onChange={(e) => onChange({ ...design, name: e.target.value })}
          />
        </label>
        {tab === "equipment" && eq.capacity_mode !== "area" && (
          <div className="capacity">
            <span>입력 DC 용량 (직렬 단위 조정 전)</span>
            <strong>
              {num(
                (Number(eq.module_count) *
                  Number(
                    eq.module_preset === "land_480"
                      ? 480
                      : eq.module_preset === "floating_450"
                        ? 450
                        : eq.module_power_w,
                  )) /
                  1000,
                1,
              )}{" "}
              kW
            </strong>
          </div>
        )}
        <Fields
          fields={group.fields}
          values={values}
          onChange={(k, v) =>
            onChange({
              ...design,
              [group.key]: {
                ...design[group.key],
                [k]: k === "stress_pcts" ? parseStress(v) : v,
              },
            })
          }
        />
        <p className="hint">
          {tab === "site"
            ? "경사각은 후보지 위치로 가이드라인 표 3-19(50 km 이내 K-water 정수장) 또는 표 3-18에서 정합니다. 풍속·적설·지진 계수는 결과의 ①단계에 표시됩니다."
            : tab === "equipment"
              ? "직렬 수(표 3-13)·인버터 구성(표 3-12)·접속반(표 3-14)은 자동 산정됩니다. 물리 모델 항목은 ‘물리 모델 단독’ 결과에만 쓰이며, 보정값에는 실제 손실이 이미 반영되어 있습니다."
              : tab === "costs"
                ? "모듈(표 3-9)·인버터(표 3-12) 단가는 가이드라인 값으로 자동 반영됩니다. ‘견적 가정’ 항목은 가이드라인에 없으므로 실제 견적으로 바꾸세요."
                : "B/C = 유입 현재가치 ÷ 유출 현재가치. 필요 판매단가는 B/C = 1이 되는 단가로, 입찰가가 아닌 후보지 비교 참고값입니다."}
        </p>
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
      label: "설치 유형",
      options: [
        ["floating", "수상 (댐·저수지 수면)"],
        ["plant", "정수장 부지"],
        ["basin", "침전지 상부"],
        ["land", "육상"],
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
