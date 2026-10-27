import type { ReactNode } from "react";
import { date, num } from "./api";
import { MonthlyEnergyChart, ReviewSteps, Term, Verdict } from "./Steps";
import type { Run } from "./types";

const eok = (won: number | null | undefined, digits = 1) =>
  won == null ? "—" : `${num(won / 100000000, digits)}억 원`;

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="report-section">
      <h2>
        <span className="report-n">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A short, centred review document; full calculation detail lives in the appendix. */
export default function ReportBody({ run, appendix }: { run: Run; appendix: ReactNode }) {
  const result = run.result!;
  const { site, equipment, costs, revenue } = result.steps;
  const e = result.economics;
  const cal = result.calibration && result.energy_basis === "calibrated" ? result.calibration : null;
  const kpis: [ReactNode, string, string?][] = [
    ["설비용량", `${num(result.capacity_dc_kw, 0)} kW`, `AC ${num(result.capacity_ac_kw)} kW`],
    ["연간 발전량", `${num(result.annual_kwh / 1000, 0)} MWh`, cal ? `범위 ${num(cal.annual_p10_kwh / 1000, 0)}–${num(cal.annual_p90_kwh / 1000, 0)} MWh` : "물리 모델 단독"],
    [<Term name="설비이용률" key="cf" />, `${num(result.capacity_factor_pct, 1)}%`, `하루 ${num(result.daily_hours, 1)}시간 발전`],
    ["총 공사비", eok(costs.total), `kW당 ${num(costs.per_kw / 10000, 0)}만 원`],
    [<Term name="B/C" key="bc" />, num(e.bc, 2), e.bc != null && e.bc >= 1 ? "1 이상 · 비용 회수" : "1 미만"],
    [<Term name="NPV" key="npv" />, eok(e.npv), `${e.cashflows.length - 1}년 · 할인 후`],
    [<Term name="IRR" key="irr" />, e.irr_pct == null ? "—" : `${num(e.irr_pct, 1)}%`, `회수 ${num(e.payback_years, 1)}년`],
    [<Term name="필요 판매단가" key="req" />, `${num(e.required_price_per_kwh, 1)}원/kWh`, `가정 단가 ${num(e.effective_price_per_kwh, 0)}원`],
    ["CO₂ 감축", `${num(result.steps.substitution.co2_t, 0)} t/년`, `${num(result.steps.substitution.households, 0)}가구 전력`],
  ];
  const steps: [string, string][] = [
    ["① 설치대상지", `${site.province} ${site.nearest_city} · ${site.structure_type === "seasonal" ? "가변형" : `고정형 ${site.tilt}°`} · 정남향 · 설계풍속 ${site.wind_speed_ms} m/s`],
    ["② 기자재", `${equipment.module.module_power_w} W × ${num(equipment.module_count)}장 = ${num(result.capacity_dc_kw, 0)} kW · 인버터 ${equipment.inverter.units.map((u) => `${u.kw} kW×${u.count}`).join(" + ")} · ${equipment.grid.voltage}`],
    ["③ 발전량", `연 ${num(result.annual_kwh / 1000, 0)} MWh · ${result.physics.years.length}년 기상(${result.physics.years[0]}~${result.physics.years.at(-1)}) · ${cal ? "운영실적 보정" : "물리 모델"}`],
    ["④ 공사비", `${eok(costs.total)} · 연 유지관리 ${num(costs.annual_om / 10000)}만 원`],
    ["⑤ 수익", `1년차 ${eok(revenue.first_year_revenue, 2)} (${num(revenue.price_per_kwh, 0)}원/kWh${revenue.purpose === "self" ? ", 소내소비 포함" : ""})`],
    ["⑥ 재무성", `B/C ${num(e.bc, 2)} · NPV ${eok(e.npv)} · 필요 판매단가 ${num(e.required_price_per_kwh, 1)}원`],
  ];
  const assumed = costs.items.filter((item) => item.source.includes("가정"));
  const checks = [
    ...(assumed.length ? [`${assumed.map((item) => item.label).join("·")} 단가는 가이드라인에 없는 가정값입니다. 실제 견적으로 바꿔 다시 분석하세요.`] : []),
    ...result.provenance.warnings.filter((w) => !w.startsWith("개략 모듈 배치")).slice(0, 4),
    "인허가, 계통 접속 가능 용량, 구조·계류 안전성은 별도 확인이 필요합니다.",
  ];
  return (
    <article className="report">
      <header className="report-title">
        <span className="report-kicker">수상태양광 사전 사업성 검토 보고서</span>
        <h1>{run.snapshot.candidate.name}</h1>
        <p>
          {run.snapshot.design.name} · {run.snapshot.project.name}
        </p>
        <div className="report-details">
          <span>분석일 {date(run.created_at)}</span>
          <span>기준: K-water 표준설계모델 가이드라인</span>
          <span>{cal ? "발전량: K-water 운영실적 보정" : "발전량: 물리 모델"}</span>
        </div>
      </header>

      <Section n={1} title="결론">
        <Verdict result={result} />
      </Section>

      <Section n={2} title="핵심 지표">
        <div className="report-kpis">
          {kpis.map(([label, value, sub], i) => (
            <div key={i}>
              <span>{label}</span>
              <b>{value}</b>
              {sub && <small>{sub}</small>}
            </div>
          ))}
        </div>
      </Section>

      <Section n={3} title="월별 발전량">
        <MonthlyEnergyChart result={result} />
        <p className="hint">
          막대는 {cal ? "운영실적으로 보정한 발전량과 검증 오차 범위" : "물리 모델 발전량"}, 선은 보정 전 물리 모델입니다(단위 MWh).
        </p>
      </Section>

      <Section n={4} title="가이드라인 6단계 요약">
        <table className="report-table">
          <tbody>
            {steps.map(([label, text]) => (
              <tr key={label}>
                <th>{label}</th>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section n={5} title="발전량이 예상보다 적다면">
        <table className="report-table numbers">
          <thead>
            <tr>
              <th>경우</th>
              <th>연간 발전량</th>
              <th>B/C</th>
              <th>필요 판매단가</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>기준</th>
              <td>{num(result.annual_kwh / 1000, 0)} MWh</td>
              <td>{num(e.bc, 2)}</td>
              <td>{num(e.required_price_per_kwh, 1)}원</td>
            </tr>
            {result.stress.map((s) => (
              <tr key={s.label} className={s.bc != null && s.bc < 1 ? "below" : ""}>
                <th>{s.label}</th>
                <td>{num(s.annual_kwh / 1000, 0)} MWh</td>
                <td>{num(s.bc, 2)}</td>
                <td>{num(s.required_price_per_kwh, 1)}원</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section n={6} title="공사비 구성">
        <div className="cost-bars">
          {costs.items
            .filter((item) => item.amount > 0)
            .sort((a, b) => b.amount - a.amount)
            .map((item) => (
              <div key={item.key}>
                <span>
                  {item.label}
                  {item.source.includes("가정") && <em>견적 가정</em>}
                </span>
                <i style={{ width: `${(item.amount / costs.total) * 100}%` }} />
                <b>
                  {eok(item.amount, 2)} · {num((item.amount / costs.total) * 100, 0)}%
                </b>
              </div>
            ))}
        </div>
      </Section>

      <Section n={7} title="확인이 필요한 사항">
        <ul className="report-checks">
          {[...new Set(checks)].map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      </Section>

      <details className="report-appendix">
        <summary>부록 · 상세 산정 근거 (6단계 전체, 연도별 현금흐름, 대안 비교, 가정 목록)</summary>
        <ReviewSteps run={run} expandAll />
        {appendix}
        <h3>계산 가정 전체</h3>
        <p className="hint">
          기상자료: {result.provenance.weather_source} · {result.provenance.period.start.slice(0, 10)} ~{" "}
          {result.provenance.period.end.slice(0, 10)}
        </p>
        <ul>
          {result.provenance.assumptions.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
        <details>
          <summary>입력 스냅샷 (JSON)</summary>
          <pre>{JSON.stringify(run.snapshot, null, 2)}</pre>
        </details>
      </details>

      <footer className="report-bottom">
        수면 · 수상태양광 사업성 검토
        <span>사전 검토용 자료이며 설치 확정·투자 수익 보장이 아닙니다.</span>
      </footer>
    </article>
  );
}
