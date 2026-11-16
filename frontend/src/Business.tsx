import { Fragment } from "react";
import type { AssumptionRow, PriceScenario, Result } from "./types";
import { num } from "./api";

const eok = (won: number) => `${num(won / 100000000, 2)}억 원`;
const AZ_LABEL: Record<number, string> = { 90: "동 90°", 135: "남동 135°", 180: "남 180°", 225: "남서 225°", 270: "서 270°" };

/** 좌표 기준 최근접 기상청 관측소와 발전량 예측에 쓰는 기상자료. */
export function WeatherStationCard({ result }: { result: Result }) {
  const site = result.steps.site;
  const st = site.weather_station;
  if (!st) return null;
  return (
    <section className="card">
      <div className="card-heading">
        <h3>연결된 기상 관측소</h3>
        <span className="muted">후보지 좌표 기준 거리</span>
      </div>
      <p className="station-line">
        <b>
          {st.name} ({st.stn})
        </b>{" "}
        · 후보지에서 {num(st.distance_km ?? 0, 1)} km
        {site.nearby_stations && site.nearby_stations.length > 1 && (
          <span className="muted">
            {" "}
            (다음으로 가까운 곳:{" "}
            {site.nearby_stations
              .slice(1)
              .map((s) => `${s.name} ${num(s.distance_km ?? 0, 1)} km`)
              .join(", ")}
            )
          </span>
        )}
      </p>
      <p className="station-line">
        일사량 보정:{" "}
        {site.irradiance_station?.mode === "nearest" ? (
          <>
            <b>
              {site.irradiance_station.name} ({site.irradiance_station.stn})
            </b>{" "}
            일사계 · {num(site.irradiance_station.distance_km ?? 0, 1)} km (일사 관측이 있는 가장 가까운 관측소)
          </>
        ) : site.irradiance_station ? (
          <>기상청 {site.irradiance_station.name} 일사계 월별 계수(전 지역 공통)</>
        ) : (
          <span className="muted">적용 안 함 (보정 모델 검증에서 오차가 줄지 않았거나 일사 관측소가 멀어서)</span>
        )}
      </p>
      {site.weather_basis && <p className="hint">{site.weather_basis}</p>}
    </section>
  );
}

/** 용량 산정에 쓴 입력 방식과 배치 가정값. */
export function CapacityPlanCard({ result }: { result: Result }) {
  const eq = result.steps.equipment;
  const plan = eq.plan;
  if (!plan) return null;
  return (
    <section className="card">
      <div className="card-heading">
        <h3>설비 용량 산정 · {plan.mode_label}</h3>
      </div>
      <div className="stats compact">
        {plan.mode === "site_area" && (
          <div className="stat">
            <span className="stat-label">부지 면적</span>
            <strong>
              {num(plan.site_area_m2!, 0)}
              <small>m²</small>
            </strong>
            <span className="stat-sub">여유 면적 {num(plan.reserve_pct!, 0)}% 제외</span>
          </div>
        )}
        {plan.mode === "capacity" && (
          <div className="stat">
            <span className="stat-label">목표 총 설비용량</span>
            <strong>
              {num(plan.target_capacity_kw!, 1)}
              <small>kW</small>
            </strong>
            <span className="stat-sub">입력값</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-label">모듈</span>
          <strong>
            {num(plan.module_power_w, 0)}
            <small>W/장</small>
          </strong>
          <span className="stat-sub">
            {eq.module_manufacturer ? `${eq.module_manufacturer} · ` : ""}
            {eq.module.module_model}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">모듈 수</span>
          <strong>
            {num(eq.module_count, 0)}
            <small>장</small>
          </strong>
          <span className="stat-sub">
            {eq.module_count !== plan.requested_modules
              ? `요청 ${num(plan.requested_modules, 0)}장 → 직렬 구성 맞춤`
              : plan.mode === "capacity"
                ? "필요 모듈 수"
                : "설치 가능 모듈 수"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">실제 설치용량</span>
          <strong>
            {num(result.capacity_dc_kw, 1)}
            <small>kW</small>
          </strong>
          <span className="stat-sub">모듈용량 × 모듈 수</span>
        </div>
      </div>
      <p className="hint">
        배치 가정: 어레이 행 피치 {num(plan.row_pitch_m, 2)} m(행간 이격 {num(plan.row_gap_m, 2)} m), 모듈 1장당 점유면적{" "}
        {num(plan.module_footprint_m2, 2)} m²{plan.pitch_basis ? ` · ${plan.pitch_basis}` : ""}.
        {plan.mode === "site_area" &&
          ` 배치 가능 면적 ${num(plan.usable_area_m2!, 0)} m², 지면 점유율 ${num(plan.ground_coverage_pct!, 1)}%.`}
        {eq.module_source && ` 모듈 제원 출처: ${eq.module_source}.`}
      </p>
    </section>
  );
}

/** 경사각 × 방위각 조합별 예상 연간 발전량. */
export function AngleComparison({
  result,
  onApply,
}: {
  result: Result;
  onApply?: (tilt: number, azimuth: number) => void;
}) {
  const angles = result.steps.site.angles;
  if (!angles) return null;
  const tilts = [...new Set(angles.rows.map((r) => r.tilt))].sort((a, b) => a - b);
  const azs = [...new Set(angles.rows.map((r) => r.azimuth))].sort((a, b) => a - b);
  const cell = (t: number, a: number) => angles.rows.find((r) => r.tilt === t && r.azimuth === a);
  const max = Math.max(...angles.rows.map((r) => r.ratio));
  const min = Math.min(...angles.rows.map((r) => r.ratio));
  return (
    <section className="card">
      <div className="card-heading">
        <h3>경사각·방위각 조건별 예상 발전량</h3>
        <span className="muted">단위 MWh/년 · 괄호는 분석 조건 대비</span>
      </div>
      <div className="table-scroll">
        <table className="angle-table">
          <thead>
            <tr>
              <th>경사각 \ 방위각</th>
              {azs.map((a) => (
                <th key={a}>{AZ_LABEL[a] ?? `${num(a, 0)}°`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tilts.map((t) => (
              <tr key={t}>
                <th>{num(t, 0)}°</th>
                {azs.map((a) => {
                  const r = cell(t, a);
                  if (!r) return <td key={a}>-</td>;
                  const heat = max > min ? (r.ratio - min) / (max - min) : 1;
                  const best = t === angles.best.tilt && a === angles.best.azimuth;
                  return (
                    <td
                      key={a}
                      className={(r.selected ? "selected " : "") + (best ? "best" : "")}
                      style={{ ["--heat" as string]: heat.toFixed(3) }}
                    >
                      {onApply && !r.selected ? (
                        <button className="link" title="이 조건으로 설계 조건 변경" onClick={() => onApply(t, a)}>
                          {num(r.annual_kwh / 1000, 0)}
                        </button>
                      ) : (
                        num(r.annual_kwh / 1000, 0)
                      )}
                      <small>
                        {r.selected ? "분석 조건" : `${r.ratio >= 1 ? "+" : ""}${num((r.ratio - 1) * 100, 1)}%`}
                      </small>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        가장 많은 조합: 경사 {num(angles.best.tilt, 0)}° · 방위 {num(angles.best.azimuth, 0)}° (분석 조건 대비{" "}
        {num((angles.best.ratio - 1) * 100, 1)}%). {angles.basis}
        {angles.seasonal && " 가변형 구조는 고정 경사각 기준으로 비교했습니다."}
        {onApply && " 숫자를 누르면 그 조건으로 2단계 설계 조건이 바뀝니다(저장 후 다시 분석)."}
      </p>
    </section>
  );
}

/** 현금 유입: 월별 예상 매출과 판매단가 시나리오. */
export function CashInflow({ result }: { result: Result }) {
  const rev = result.steps.revenue;
  const e = result.economics;
  return (
    <>
      {rev.monthly && (
        <section className="card">
          <div className="card-heading">
            <h3>현금 유입 · 1년차 월별 예상 매출</h3>
            <span className="muted">예측 발전량 × 판매단가 {num(rev.price_per_kwh, 1)}원/kWh</span>
          </div>
          <div className="table-scroll">
            <table className="month-table">
              <thead>
                <tr>
                  <th />
                  {rev.monthly.map((m) => (
                    <th key={m.month}>{m.month}월</th>
                  ))}
                  <th>연간</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>발전량 (MWh)</th>
                  {rev.monthly.map((m) => (
                    <td key={m.month}>{num(m.energy_kwh / 1000, 0)}</td>
                  ))}
                  <td>
                    <b>{num(result.annual_kwh / 1000, 0)}</b>
                  </td>
                </tr>
                <tr>
                  <th>매출 (만 원)</th>
                  {rev.monthly.map((m) => (
                    <td key={m.month}>{num(m.revenue / 10000, 0)}</td>
                  ))}
                  <td>
                    <b>{num(rev.first_year_revenue / 10000, 0)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            신규 후보지는 판매 실적이 없으므로 예측 발전량에 사용자가 정한 판매단가를 곱했습니다. 출력제한·소내소비를 반영한 1년차 기준이며, 사업기간{" "}
            {rev.years ?? ""}년 누적 매출은 {eok(rev.total_revenue ?? e.total_revenue ?? 0)}입니다(열화율 반영).
          </p>
        </section>
      )}
      {rev.scenarios && <ScenarioTable rows={rev.scenarios} />}
    </>
  );
}

export function ScenarioTable({ rows }: { rows: PriceScenario[] }) {
  return (
    <section className="card">
      <div className="card-heading">
        <h3>판매단가 시나리오별 결과</h3>
        <span className="muted">같은 발전량·비용, 판매단가만 변경</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>시나리오</th>
              <th>판매단가 (원/kWh)</th>
              <th>1년차 매출</th>
              <th>사업기간 매출</th>
              <th>순수익 (누적)</th>
              <th>NPV</th>
              <th>B/C</th>
              <th>투자회수기간</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.kind === "user" ? "highlight" : ""}>
                <th>{r.label}</th>
                <td>{num(r.price_per_kwh, 1)}</td>
                <td>{eok(r.first_year_revenue)}</td>
                <td>{eok(r.total_revenue)}</td>
                <td className={r.net_profit < 0 ? "negative" : ""}>{eok(r.net_profit)}</td>
                <td className={r.npv < 0 ? "negative" : ""}>{eok(r.npv)}</td>
                <td>{r.bc == null ? "-" : num(r.bc, 2)}</td>
                <td>{r.payback_years == null ? "회수 안 됨" : `${num(r.payback_years, 1)}년`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        최소 필요 판매단가는 할인 후 유입과 유출이 같아지는(B/C = 1) 단가로, 참고용입니다. 순수익은 할인 전 누적 현금흐름
        (매출 − 운영·교체비 − 초기 투자비)입니다. 비교 시나리오는 2단계 ‘⑤⑥ 수익·재무’에서 추가할 수 있습니다.
      </p>
    </section>
  );
}

/** 사업성 결과 핵심 지표. */
export function ResultSummary({ result }: { result: Result }) {
  const e = result.economics;
  const items: [string, string, string][] = [
    ["총 투자비", eok(e.capex), `kW당 ${num(e.capex / result.capacity_dc_kw / 10000, 0)}만 원`],
    ["1년차 예상 매출", eok(e.first_year_revenue), `판매단가 ${num(e.effective_price_per_kwh, 1)}원/kWh`],
    ["사업기간 예상 매출", eok(e.total_revenue ?? 0), `${e.cashflows.length - 1}년 누적`],
    [
      "최소 필요 판매단가",
      e.required_price_per_kwh == null ? "-" : `${num(e.required_price_per_kwh, 1)}원/kWh`,
      "손익분기 (B/C = 1)",
    ],
    ["투자회수기간", e.payback_years == null ? "회수 안 됨" : `${num(e.payback_years, 1)}년`, "할인 전 누적 기준"],
    ["순수익 (누적)", eok(e.net_profit ?? 0), "매출 − 운영비 − 투자비"],
    ["NPV", eok(e.npv), "할인 후 순현재가치"],
    ["B/C · IRR", `${e.bc == null ? "-" : num(e.bc, 2)} · ${e.irr_pct == null ? "-" : num(e.irr_pct, 1) + "%"}`, "편익/비용 · 내부수익률"],
  ];
  return (
    <div className="stats result-summary">
      {items.map(([label, value, sub]) => (
        <div className="stat" key={label}>
          <span className="stat-label">{label}</span>
          <strong className={value.startsWith("-") && value.length > 1 ? "negative" : ""}>{value}</strong>
          <span className="stat-sub">{sub}</span>
        </div>
      ))}
    </div>
  );
}

/** 가정값 · 단위 · 출처. */
export function AssumptionTable({ rows }: { rows?: AssumptionRow[] }) {
  if (!rows?.length) return null;
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <section className="card">
      <div className="card-heading">
        <h3>사용한 가정값 · 단위 · 출처</h3>
      </div>
      <div className="table-scroll">
        <table className="assumption-table">
          <thead>
            <tr>
              <th>구분</th>
              <th>항목</th>
              <th>값</th>
              <th>단위</th>
              <th>출처</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                {rows
                  .filter((r) => r.group === g)
                  .map((r, i) => (
                    <tr key={g + r.label}>
                      {i === 0 && <th rowSpan={rows.filter((x) => x.group === g).length}>{g}</th>}
                      <td>{r.label}</td>
                      <td className="num">{typeof r.value === "number" ? num(r.value, r.value % 1 ? 2 : 0) : r.value}</td>
                      <td>{r.unit}</td>
                      <td>
                        <span className={/가정|견적/.test(r.source) ? "tag assumed" : "tag"}>{r.source}</span>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
