import { Children, createContext, useContext, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { num } from "./api";
import type { Result, Run } from "./types";

// Validated categorical order (dataviz validator: all checks pass on white).
export const series = ["#2563eb", "#0d9488", "#d97706"];
export const axis = { fill: "#6b7280", fontSize: 12 };
export const tooltipStyle = {
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  fontSize: 13,
};
const won = (value: number | null | undefined, digits = 2) =>
  value == null ? "—" : num(value / 100000000, digits);
const SITE_TYPE: Record<string, string> = {
  floating: "수상 (댐·저수지)",
  plant: "정수장 부지",
  basin: "침전지 상부",
  land: "육상",
};
const SEASON: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};

export const GLOSSARY: Record<string, string> = {
  "B/C": "편익·비용비. 사업기간 동안 들어오는 돈(현재가치)을 나가는 돈(현재가치)으로 나눈 값입니다. 1 이상이면 할인율을 감안해도 비용을 회수합니다.",
  NPV: "순현재가치. 미래 수입과 비용을 할인율로 현재 가치로 바꿔 뺀 금액입니다. 0보다 크면 이익입니다.",
  IRR: "내부수익률. NPV가 0이 되는 할인율입니다. 할인율(자본비용)보다 높을수록 유리합니다.",
  "필요 판매단가": "B/C가 정확히 1이 되는 전력 판매단가입니다. 실제 계약단가가 이보다 높을수록 여유가 있습니다. 입찰가가 아니라 후보지 비교용 기준값입니다.",
  "P10–P90": "운영 발전소로 검증한 예측 오차 범위입니다. 실제 발전량이 이 범위 아래(P10 미만)일 확률은 약 10%, 위(P90 초과)일 확률도 약 10%입니다.",
  MAPE: "평균 절대 백분율 오차. 월 발전량 예측이 실제와 평균 몇 % 차이 나는지를 뜻합니다. 낮을수록 정확합니다.",
  "장소 분리 검증": "발전소 하나를 빼고 나머지로 모델을 만든 뒤, 뺀 발전소를 예측해 오차를 재는 방식입니다. 처음 보는 후보지에 대한 성능을 정직하게 보여줍니다.",
  설비이용률: "1년 내내 정격출력으로 발전했을 때 대비 실제 발전량의 비율입니다. 국내 태양광은 보통 13~16%입니다.",
};
/** A term with a dotted underline; hover or focus shows the plain explanation. */
export function Term({ name, children }: { name: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  return (
    <abbr className="term" title={GLOSSARY[name]} tabIndex={0}>
      {children ?? name}
    </abbr>
  );
}

// Steps open by default; the others show only their one-line summary.
const OPEN_STEPS = new Set(["energy", "finance"]);
// The printable report expands every step.
const ExpandAll = createContext(false);

type StepProps = {
  id: string;
  title: string;
  source?: string;
  summary?: ReactNode;
  children: ReactNode;
};
function Step({ id, title, source, summary, children }: StepProps) {
  return (
    <details className="card step" id={`step-${id}`} open={useContext(ExpandAll) || OPEN_STEPS.has(id)}>
      <summary>
        <div className="card-heading">
          <h3>{title}</h3>
          {source && <span className="source-chip">{source}</span>}
        </div>
        {summary && <p className="step-summary">{summary}</p>}
      </summary>
      <div className="step-body">{children}</div>
    </details>
  );
}

type Tone = "good" | "warn" | "bad";
/** Plain-language conclusion of one completed run, shown above the details. */
export function Verdict({ result }: { result: Result }) {
  const e = result.economics;
  const cal = result.calibration;
  const worst = result.stress.at(-1);
  const p10 = result.stress.find((s) => s.label.includes("P10"));
  const bc = e.bc ?? 0;
  const robust = result.stress.every((s) => (s.bc ?? 0) >= 1);
  const tone: Tone = bc >= 1 && robust ? "good" : bc >= 1 ? "warn" : "bad";
  const headline =
    tone === "good"
      ? "사업성이 확인됩니다"
      : tone === "warn"
        ? "기준 조건에서는 사업성이 있지만, 발전량이 줄면 위험합니다"
        : "현재 조건에서는 사업성이 부족합니다";
  const margin =
    e.required_price_per_kwh == null
      ? null
      : e.effective_price_per_kwh - e.required_price_per_kwh;
  return (
    <section className={`verdict ${tone}`} aria-label="검토 결론">
      <div className="verdict-head">
        <span className="verdict-badge">
          {tone === "good" ? "✓ 적합" : tone === "warn" ? "! 조건부" : "✕ 부족"}
        </span>
        <h2>{headline}</h2>
      </div>
      <ul>
        <li>
          연간 <b>{num(result.annual_kwh / 1000, 0)} MWh</b> 발전이 예상됩니다
          {cal && result.energy_basis === "calibrated" ? (
            <>
              {" "}(<Term name="P10–P90" />{" "}
              {num(cal.annual_p10_kwh / 1000, 0)}~{num(cal.annual_p90_kwh / 1000, 0)} MWh, K-water 운영실적 검증 기준).
            </>
          ) : (
            " (물리 모델 단독, 실적 보정 전)."
          )}
        </li>
        {margin != null && (
          <li>
            <Term name="필요 판매단가" />는 <b>{num(e.required_price_per_kwh, 1)}원/kWh</b>로, 가정한 판매단가{" "}
            {num(e.effective_price_per_kwh, 1)}원보다{" "}
            <b>{num(Math.abs(margin), 1)}원 {margin >= 0 ? "낮습니다" : "높습니다"}</b>
            {margin >= 0 ? " (여유 있음)." : " (단가가 부족함)."}
          </li>
        )}
        <li>
          <Term name="B/C" /> <b>{num(e.bc, 2)}</b>
          {worst && (
            <>
              {" "}· {worst.label}이면 <b>{num(worst.bc, 2)}</b>
            </>
          )}
          {p10 && p10 !== worst && (
            <>
              {" "}· 검증 하한(P10)이면 <b>{num(p10.bc, 2)}</b>
            </>
          )}
          {robust ? " → 모든 점검 조건에서 1 이상입니다." : " → 1 미만이 되는 조건이 있습니다."}
        </li>
      </ul>
    </section>
  );
}
function Facts({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <dl className="step-facts">
      {rows.map(([label, value, note]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {value}
            {note && <small>{note}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function MonthlyEnergyChart({ result }: { result: Result }) {
  const calibrated = result.energy_basis === "calibrated";
  const data = result.monthly.map((m) => ({
    month: `${m.month}월`,
    energy: m.energy_kwh / 1000,
    physics: m.physics_kwh / 1000,
    band:
      calibrated && m.p10_kwh != null && m.p90_kwh != null
        ? [(m.energy_kwh - m.p10_kwh) / 1000, (m.p90_kwh - m.energy_kwh) / 1000]
        : undefined,
  }));
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#eef0f3" />
          <XAxis dataKey="month" axisLine={false} tickLine={false} tick={axis} />
          <YAxis axisLine={false} tickLine={false} tick={axis} unit="" />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "#f3f4f6" }}
            formatter={(v, name) =>
              name === "band" ? null : [`${num(Number(v), 1)} MWh`, name]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="energy"
            name={calibrated ? "운영실적 보정 발전량 (P10–P90)" : "물리 모델 발전량"}
            fill={series[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          >
            {calibrated && (
              <ErrorBar dataKey="band" width={6} strokeWidth={1.5} stroke="#374151" />
            )}
          </Bar>
          {calibrated && (
            <Line
              dataKey="physics"
              name="물리 모델 단독 (pvlib)"
              stroke={series[2]}
              strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ReviewSteps({ run, expandAll = false }: { run: Run; expandAll?: boolean }) {
  const result = run.result!;
  const { site, equipment, costs, revenue, substitution } = result.steps;
  const e = result.economics;
  const cal = result.calibration;
  // Short label and headline number per step for the board view.
  const highlights: Record<string, [string, string]> = {
    site: ["설치대상지", site.structure_type === "seasonal" ? "가변형" : `고정형 ${site.tilt}°`],
    equipment: ["기자재·용량", `${num(result.capacity_dc_kw, 0)} kW`],
    energy: ["연간 발전량", `${num(result.annual_kwh / 1000, 0)} MWh`],
    costs: ["개략공사비", `${num(costs.total / 100000000, 1)}억 원`],
    revenue: ["예상수익", `${num(revenue.first_year_revenue / 100000000, 2)}억/년`],
    finance: ["재무성", `B/C ${num(e.bc, 2)}`],
  };
  const steps = Children.toArray(
    (
      <>
      <Step
        id="site"
        title="① 설치대상지 선정"
        source="가이드라인 3.5 · 표 3-4·3-18~3-21"
        summary={
          <>
            {site.province} {site.nearest_city} 권역 · 정남향{" "}
            {site.structure_type === "seasonal" ? "가변형(계절별 경사 조정)" : `고정형 ${site.tilt}°`} ·
            풍속 {site.wind_speed_ms} m/s 기준으로 설계합니다.
          </>
        }
      >
        <Facts
          rows={[
            ["지역", `${site.province} · ${site.nearest_city}`, site.region_basis],
            ["설치 유형", SITE_TYPE[site.site_type] || site.site_type],
            [
              "구조물 / 경사각",
              site.structure_type === "seasonal"
                ? `가변형 · ${Object.entries(site.seasonal_tilts)
                    .map(([k, v]) => `${SEASON[k]} ${v}°`)
                    .join(" / ")}`
                : `고정형 · ${site.tilt}°`,
              site.structure_type === "seasonal"
                ? site.seasonal_basis
                : site.tilt_mode === "guideline"
                  ? site.tilt_basis
                  : "사용자 입력",
            ],
            ["방위각", `${site.azimuth}°`, site.azimuth_basis],
            ["설계 최대풍속", `${site.wind_speed_ms} m/s`, site.structural_basis],
            ["지상적설하중", `${site.snow_load_kn_m2} kN/m²`],
            ["지진구역", `${site.seismic_zone} · ${site.seismic_coeff_g}g`],
          ]}
        />
        {site.climate && <ClimateCheck climate={site.climate} />}
      </Step>
      <Step
        id="equipment"
        title="② 부지면적 및 기자재 기술사양"
        source="표 3-9·3-12~3-15·3-22"
        summary={
          <>
            {equipment.module.module_power_w} W 모듈 {num(equipment.module_count)}장 ={" "}
            <b>{num(result.capacity_dc_kw, 1)} kW</b>, 인버터{" "}
            {equipment.inverter.units.map((u) => `${u.kw} kW×${u.count}`).join(" + ")}, {equipment.grid.voltage} 연계.
          </>
        }
      >
        <Facts
          rows={[
            [
              "수면 면적",
              equipment.area_m2 == null
                ? "경계 없음"
                : `${num(equipment.area_m2 / 10000, 2)} ha`,
              equipment.max_modules_by_area == null
                ? "기존 발전소 재현 검토"
                : `이격거리 기준 최대 ${num(equipment.max_modules_by_area)}장`,
            ],
            [
              "모듈",
              `${equipment.module.module_model}`,
              `${num(equipment.module.module_width_m * 1000)} × ${num(equipment.module.module_height_m * 1000)} mm · ${num(equipment.module.module_price)}원/장`,
            ],
            [
              "어레이 이격",
              `${num(equipment.pitch.pitch_m, 2)} m`,
              `${equipment.pitch.basis} · 투영 ${num(equipment.pitch.plan_depth_m, 2)} m + 간격 ${num(equipment.pitch.gap_m, 2)} m`,
            ],
            [
              "직렬 × 병렬",
              `${equipment.strings.series}직렬 × ${num(equipment.strings.parallel)}병렬 = ${num(equipment.module_count)}장`,
              `허용 ${equipment.strings.series_min}~${equipment.strings.series_max}직렬 · ${equipment.strings.basis}`,
            ],
            [
              "인버터",
              equipment.inverter.units.map((u) => `${u.kw} kW × ${u.count}대`).join(" + "),
              `${equipment.inverter.rule} · AC ${num(equipment.inverter.ac_capacity_kw)} kW`,
            ],
            [
              "접속반",
              equipment.inverter.junction_boxes
                .map((j) => `${j.channels}CH × ${j.count}면`)
                .join(" + "),
              "표 3-14 인버터 용량별 채널수",
            ],
            [
              "계통연계",
              equipment.grid.voltage,
              `${equipment.grid.network}${equipment.grid.voltage_variation_limit_pct ? ` · 전압변동률 ${equipment.grid.voltage_variation_limit_pct}% 이내` : ""} (표 3-5)`,
            ],
          ]}
        />
        {equipment.strings.warnings.map((w, i) => (
          <p className="inline-warning" key={i}>
            {w}
          </p>
        ))}
      </Step>
      <Step
        id="energy"
        title="③ 설치용량 및 연간발전량"
        source={`${result.physics.years[0]}~${result.physics.years.at(-1)} ERA5 시간자료`}
        summary={
          <>
            {result.physics.years.length}년 실제 기상으로 계산하면 연간 <b>{num(result.annual_kwh / 1000, 0)} MWh</b>
            {result.energy_basis === "calibrated"
              ? ` (운영실적 보정 후, 보정 전 물리 모델보다 ${num((1 - result.annual_kwh / result.physics.annual_kwh) * 100, 1)}% 낮음)`
              : " (물리 모델 단독)"}
            입니다.
          </>
        }
      >
        <div className="metrics">
          <div>
            <span>
              <Term name="설비이용률" />
            </span>
            <strong>
              {num(result.capacity_factor_pct, 1)}
              <small>%</small>
            </strong>
            <small>일 {num(result.daily_hours, 2)}시간 발전</small>
          </div>
          <div>
            <span>물리 모델 단독</span>
            <strong>
              {num(result.physics.annual_kwh / 1000, 1)}
              <small>MWh</small>
            </strong>
            <small>
              보정값보다 {num((result.physics.annual_kwh / result.annual_kwh - 1) * 100, 1)}% 높음
            </small>
          </div>
        </div>
        <MonthlyEnergyChart result={result} />
        <p className="hint">
          {cal && result.energy_basis === "calibrated"
            ? `${cal.model_label} · 오차 막대는 ${cal.band_basis}(발전소 ${cal.band_plants}곳)의 월별 P10–P90입니다. 장소 분리 검증 월 MAPE ${num(cal.validation.all.mape_pct, 1)}%${cal.validation.floating ? `, 수상 ${num(cal.validation.floating.mape_pct, 1)}%` : ""}.`
            : "물리 모델 단독 결과입니다. 운영실적 보정 전 값이므로 실제보다 높게 나올 수 있습니다."}
          {cal?.excluded_plant && " 재현 대상 발전소는 보정 모델 학습에서 제외했습니다."}
        </p>
        <YearRange
          rows={cal && result.energy_basis === "calibrated" ? cal.annual_by_year : result.physics.annual_by_year}
        />
      </Step>
      <Step
        id="costs"
        title="④ 개략공사비"
        source="부록 2.5"
        summary={
          <>
            총 공사비 <b>{num(costs.total / 100000000, 1)}억 원</b> (kW당 {num(costs.per_kw / 10000, 0)}만 원). 주황색 ‘견적
            가정’ 항목은 가이드라인에 단가가 없어 실제 견적으로 바꿔야 합니다.
          </>
        }
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>항목</th>
                <th>산출</th>
                <th>근거</th>
                <th>금액 (만 원)</th>
              </tr>
            </thead>
            <tbody>
              {costs.items.map((item) => (
                <tr key={item.key}>
                  <th>{item.label}</th>
                  <td>{item.basis}</td>
                  <td>
                    <span className={item.source.includes("가정") ? "tag assumed" : "tag"}>
                      {item.source}
                    </span>
                  </td>
                  <td>{num(item.amount / 10000)}</td>
                </tr>
              ))}
              <tr className="total">
                <th>총 공사비</th>
                <td>kW당 {num(costs.per_kw / 10000, 1)}만 원</td>
                <td />
                <td>{num(costs.total / 10000)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          연간 유지관리비 {num(costs.annual_om / 10000)}만 원 · 인버터 교체{" "}
          {costs.replacement_year}년차 {num(costs.replacement_cost / 10000)}만 원(표 3-12 구매비)
        </p>
      </Step>
      <Step
        id="revenue"
        title="⑤ 예상수익"
        source="부록 2.6"
        summary={
          <>
            1년차 수익 <b>{num(revenue.first_year_revenue / 100000000, 2)}억 원</b> ({num(revenue.price_per_kwh, 1)}원/kWh ×{" "}
            {num(revenue.first_year_sales_kwh / 1000, 0)} MWh{revenue.purpose === "self" ? " + 소내 사용분" : ""}).
          </>
        }
      >
        <Facts
          rows={[
            [
              "용도",
              revenue.purpose === "self" ? "소내소비용" : "발전용",
              revenue.purpose === "self"
                ? "소내 사용 후 잉여전력 판매"
                : "REC·SMP 또는 장기 고정가격",
            ],
            ["판매 단가", `${num(revenue.price_per_kwh, 1)} 원/kWh`],
            ["1년차 판매전력량", `${num(revenue.first_year_sales_kwh / 1000, 1)} MWh`],
            ...(revenue.purpose === "self"
              ? ([["1년차 소내 사용", `${num(revenue.first_year_self_use_kwh / 1000, 1)} MWh`]] as [string, string][])
              : []),
            ["1년차 수익", `${num(revenue.first_year_revenue / 10000)} 만 원`],
          ]}
        />
      </Step>
      <Step
        id="finance"
        title="⑥ 재무성 분석 및 에너지 대체효과"
        source="부록 2.7"
        summary={
          <>
            {e.cashflows.length - 1}년간 B/C <b>{num(e.bc, 2)}</b>, NPV {num(e.npv / 100000000, 1)}억 원. 연간 CO₂{" "}
            {num(substitution.co2_t, 0)}톤 감축 효과가 있습니다.
          </>
        }
      >
        <div className="metrics">
          <div>
            <span>유입 / 유출 현재가치</span>
            <strong>
              {won(e.pv_inflow)}
              <small> / {won(e.pv_outflow)} 억 원</small>
            </strong>
          </div>
          <div>
            <span>
              <Term name="B/C" /> · <Term name="NPV" />
            </span>
            <strong>
              {num(e.bc, 3)}
              <small> · {won(e.npv)} 억 원</small>
            </strong>
          </div>
          <div>
            <span>
              <Term name="IRR" /> · 회수기간
            </span>
            <strong>
              {num(e.irr_pct, 2)}
              <small>% · {num(e.payback_years, 1)}년</small>
            </strong>
          </div>
          <div>
            <span>
              <Term name="필요 판매단가" /> (B/C = 1)
            </span>
            <strong>
              {num(e.required_price_per_kwh, 1)}
              <small>원/kWh</small>
            </strong>
            <small>현재 단가 {num(e.effective_price_per_kwh, 1)} 원/kWh</small>
          </div>
        </div>
        <h4>발전량이 예상보다 낮을 때</h4>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>경우</th>
                <th>연간 발전량 (MWh)</th>
                <th>B/C</th>
                <th>NPV (억 원)</th>
                <th>필요 판매단가 (원/kWh)</th>
                <th>판정</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>기준</th>
                <td>{num(result.annual_kwh / 1000, 1)}</td>
                <td>{num(e.bc, 3)}</td>
                <td>{won(e.npv)}</td>
                <td>{num(e.required_price_per_kwh, 1)}</td>
                <td>{verdict(e.bc)}</td>
              </tr>
              {result.stress.map((s) => (
                <tr key={s.label}>
                  <th>{s.label}</th>
                  <td>{num(s.annual_kwh / 1000, 1)}</td>
                  <td>{num(s.bc, 3)}</td>
                  <td>{won(s.npv)}</td>
                  <td>{num(s.required_price_per_kwh, 1)}</td>
                  <td>{verdict(s.bc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={e.cashflows.map((c) => ({ year: c.year, net: c.net / 100000000 }))}
              margin={{ top: 12, left: -8, right: 12 }}
            >
              <CartesianGrid stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="year" tickLine={false} axisLine={false} tick={axis} />
              <YAxis tickLine={false} axisLine={false} tick={axis} />
              <Tooltip
                formatter={(v) => [`${num(Number(v), 2)}억 원`, "순현금흐름"]}
                labelFormatter={(y) => `${y}년차`}
                contentStyle={tooltipStyle}
              />
              <ReferenceLine y={0} stroke="#d1d5db" />
              <Bar dataKey="net" name="연간 순현금흐름" fill={series[0]} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="hint">연도별 순현금흐름(억 원). 0년차는 총 공사비입니다.</p>
        <h4>에너지 대체효과 (연간)</h4>
        <div className="metrics">
          <div>
            <span>전력 공급 가구수</span>
            <strong>
              {num(substitution.households, 1)}
              <small>가구</small>
            </strong>
          </div>
          <div>
            <span>유류 대체</span>
            <strong>
              {num(substitution.oil_toe, 1)}
              <small>TOE</small>
            </strong>
          </div>
          <div>
            <span>소나무 식재 효과</span>
            <strong>
              {num(substitution.pine_trees)}
              <small>그루</small>
            </strong>
          </div>
          <div>
            <span>CO₂ 감축</span>
            <strong>
              {num(substitution.co2_t, 1)}
              <small>tCO₂</small>
            </strong>
          </div>
        </div>
        <p className="hint">{substitution.basis}</p>
      </Step>
      </>
    ).props.children,
  ) as ReactElement<StepProps>[];
  const reference = result.reference ? <ReferenceBacktest reference={result.reference} /> : null;
  if (expandAll)
    return (
      <ExpandAll.Provider value>
        <div className="stack">
          {steps}
          {reference}
        </div>
      </ExpandAll.Provider>
    );
  return <StepBoard steps={steps} highlights={highlights} reference={reference} />;
}

/** Six step cards in one row; only the selected step's detail is shown. */
function StepBoard({
  steps,
  highlights,
  reference,
}: {
  steps: ReactElement<StepProps>[];
  highlights: Record<string, [string, string]>;
  reference: ReactNode;
}) {
  const [active, setActive] = useState("energy");
  const current = steps.find((step) => step.props.id === active) ?? steps[0];
  const { title, source, summary, children } = current.props;
  return (
    <div className="stack">
      <div className="step-board" role="tablist" aria-label="가이드라인 6단계">
        {steps.map((step, index) => {
          const [label, value] = highlights[step.props.id];
          return (
            <button
              key={step.props.id}
              role="tab"
              aria-selected={step.props.id === active}
              className={step.props.id === active ? "active" : ""}
              onClick={() => setActive(step.props.id)}
            >
              <span className="step-no">{index + 1}</span>
              <span className="step-label">{label}</span>
              <b>{value}</b>
            </button>
          );
        })}
      </div>
      <section className="card step-detail" role="tabpanel" aria-label={title}>
        <div className="card-heading">
          <h3>{title}</h3>
          {source && <span className="source-chip">{source}</span>}
        </div>
        {summary && <p className="step-summary">{summary}</p>}
        {children}
      </section>
      {reference}
    </div>
  );
}
function verdict(bc: number | null) {
  if (bc == null) return "산정 불가";
  return bc >= 1 ? "B/C ≥ 1 유지" : "B/C < 1";
}

export function ReferenceBacktest({
  reference,
}: {
  reference: NonNullable<Result["reference"]>;
}) {
  const data = reference.rows.map((r) => ({
    label: `${String(r.year).slice(2)}.${String(r.month).padStart(2, "0")}`,
    measured: r.measured_kwh / 1000,
    predicted: r.predicted_kwh / 1000,
    physics: r.physics_kwh / 1000,
  }));
  const physics = reference.metrics.physics;
  return (
    <section className="card step">
      <div className="card-heading">
        <h3>실적 재현 · {reference.plant.name}</h3>
        <span className="muted">장소 분리 검증 (이 발전소 제외 학습)</span>
      </div>
      <div className="chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={axis} minTickGap={16} />
            <YAxis axisLine={false} tickLine={false} tick={axis} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v, name) => [`${num(Number(v), 1)} MWh`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line dataKey="measured" name="실측 (유효일)" stroke={series[0]} strokeWidth={2} dot={false} />
            <Line dataKey="predicted" name={reference.model_label} stroke={series[1]} strokeWidth={2} dot={false} />
            <Line dataKey="physics" name="물리 모델 단독" stroke={series[2]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>모델</th>
              <th>월 MAPE</th>
              <th>평균 편향</th>
              <th>기간 합계 오차</th>
              <th>비교 월</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(reference.metrics).map(([key, m]) => (
              <tr key={key}>
                <th>{MODEL_NAMES[key] || key}</th>
                <td>{num(m.mape_pct, 1)}%</td>
                <td>{num(m.bias_pct, 1)}%</td>
                <td>{num(m.plant_total_abs_error_pct, 1)}%</td>
                <td>{m.months}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        {reference.note} 물리 모델 단독 월 MAPE {num(physics?.mape_pct, 1)}%.
      </p>
    </section>
  );
}
export const MODEL_NAMES: Record<string, string> = {
  physics: "물리 모델 단독 (pvlib)",
  monthly_median: "월별 실적비 중앙값 보정",
  gbr: "GBR 오차 보정",
  gbr_floating: "GBR + 수상 잔차 보정 (2단계)",
};

function ClimateCheck({
  climate,
}: {
  climate: NonNullable<Result["steps"]["site"]["climate"]>;
}) {
  return (
    <details className="detail">
      <summary>
        기후조건 확인 · 기상청 {climate.station.name} 평년값({climate.period}) 대비 분석 기간 기온 차{" "}
        {climate.temperature_bias_c >= 0 ? "+" : ""}
        {num(climate.temperature_bias_c, 1)}°C
      </summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th />
              {climate.months.map((m) => (
                <th key={m.month}>{m.month}월</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>평년 기온 °C</th>
              {climate.months.map((m) => (
                <td key={m.month}>{num(m.normal_ta, 1)}</td>
              ))}
            </tr>
            <tr>
              <th>ERA5 기온 °C ({climate.analysis_years})</th>
              {climate.months.map((m) => (
                <td key={m.month}>{num(m.reanalysis_ta, 1)}</td>
              ))}
            </tr>
            <tr>
              <th>평년 일조시간 h</th>
              {climate.months.map((m) => (
                <td key={m.month}>{num(m.normal_sunshine_hours, 0)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="hint">
        관측소까지 {num(climate.distance_km, 0)} km · 평년 최저기온(월평균 일최저) {num(climate.coldest_normal_min_c, 1)}°C.
        직렬 수 산정은 가이드라인대로 −30°C를 씁니다. {climate.basis}.
      </p>
    </details>
  );
}

function YearRange({ rows }: { rows: { year: number; energy_kwh: number }[] }) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.energy_kwh - b.energy_kwh);
  const low = sorted[0],
    high = sorted.at(-1)!;
  const mean = rows.reduce((sum, r) => sum + r.energy_kwh, 0) / rows.length;
  return (
    <details className="detail">
      <summary>
        해마다 날씨가 달라 연간 발전량은 {num(low.energy_kwh / 1000, 0)} MWh({low.year}년) ~{" "}
        {num(high.energy_kwh / 1000, 0)} MWh({high.year}년) 사이였습니다 · 평균 {num(mean / 1000, 0)} MWh
      </summary>
      <div className="year-grid">
        {rows.map((r) => (
          <div key={r.year}>
            <span>{r.year}</span>
            <b>{num(r.energy_kwh / 1000, 0)}</b>
          </div>
        ))}
      </div>
      <p className="hint">단위 MWh. 각 연도의 실제 기상으로 계산했으며, 평균이 기준 발전량입니다.</p>
    </details>
  );
}
