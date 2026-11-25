import { num } from "./api";

type Region = { district: string; administrative: string | null; legal: string | null };
type Potential = { ground_mwh: number | null; roof_mwh: number | null };
export type RegionalLocation = { status: "available" | "outside" | "unavailable" | "unmatched"; location: Region | null };
export type RegionalSummary = RegionalLocation & {
  potential: Record<"theoretical" | "technical" | "market", Potential> | null;
  district_potential: (Potential & { name: string | null }) | null;
  generation: { annual_kwh: number | null; panel_area_m2: number | null; rank: number | null; rank_area: string | null } | null;
  generation_mix: { name: string; annual_kwh: number }[];
  source_url: string;
};

const levels = [
  { key: "theoretical", label: "이론적 잠재량" },
  { key: "technical", label: "기술적 잠재량" },
  { key: "market", label: "시장 잠재량" },
] as const;

function gwh(value: number | null, divisor = 1000) {
  return value == null ? "자료 없음" : `${num(value / divisor, 2)} GWh`;
}

function StatBars({ rows, divisor = 1000 }: { rows: { name: string; value: number }[]; divisor?: number }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return <ul className="region-solar-bars">
    {rows.map((row) => <li key={row.name}>
      <span>{row.name}</span><b>{gwh(row.value, divisor)}</b>
      <div className="region-solar-bar" aria-hidden="true"><div style={{ width: `${row.value / max * 100}%` }} /></div>
    </li>)}
  </ul>;
}

export default function RegionalSolar({ tab, location, summary, onRetry, onOpenGyeonggi }: {
  tab: "potential" | "generation";
  location: RegionalLocation | null;
  summary: RegionalSummary | null;
  onRetry: () => void;
  onOpenGyeonggi: () => void;
}) {
  if (location?.status === "outside") return <div className="region-solar-content">
    <p className="region-empty">이 지역의 태양광 집계 자료는 제공되지 않습니다. 현재 연결된 지역 통계는 경기도 자료입니다.</p>
    <button type="button" className="btn" onClick={onOpenGyeonggi}>경기도 지도로 이동</button>
  </div>;
  if (location?.status === "unmatched" || summary?.status === "unmatched") {
    return <div className="region-solar-content">
      <p className="region-empty">선택한 위치에 해당하는 읍·면·동 통계를 찾지 못했습니다.</p>
      <button type="button" className="btn" onClick={onRetry}>지역 통계 다시 조회</button>
    </div>;
  }
  if (location?.status === "unavailable" || summary?.status === "unavailable") {
    return <div className="region-solar-content">
      <p className="region-empty">경기기후플랫폼에서 지역 통계를 불러오지 못했습니다.</p>
      <button type="button" className="btn" onClick={onRetry}>지역 통계 다시 조회</button>
    </div>;
  }
  if (!summary) return <p className="region-empty" role="status">지역 태양광 통계를 불러오는 중…</p>;
  const region = summary.location;
  if (!region) return <p className="region-empty">이 위치의 지역 통계가 없습니다.</p>;
  if (tab === "potential") {
    const values = summary.potential;
    const district = summary.district_potential;
    return <div className="region-solar-content">
      <h4>{district?.name || region.district} {region.administrative || region.legal}</h4>
      <p className="rank-note">행정동 기준 · 연간 태양광 잠재 발전량</p>
      {values ? <>
        <table className="region-solar-table">
          <thead><tr><th scope="col">구분</th><th scope="col">지상</th><th scope="col">옥상</th></tr></thead>
          <tbody>{levels.map(({ key, label }) => <tr key={key}>
            <th scope="row">{label}</th><td>{gwh(values[key].ground_mwh)}</td><td>{gwh(values[key].roof_mwh)}</td>
          </tr>)}</tbody>
        </table>
        {district?.name && district.ground_mwh != null && values.theoretical.ground_mwh != null && <div className="region-solar-chart">
          <h5>이론적 지상 잠재량 비교</h5>
          <StatBars rows={[{ name: district.name, value: district.ground_mwh },
            { name: region.administrative || region.legal || "선택 지역", value: values.theoretical.ground_mwh }]} />
        </div>}
      </> : <>
        <p className="region-empty">선택한 위치의 행정동 잠재량을 확인하지 못했습니다.</p>
        <button type="button" className="btn" onClick={onRetry}>지역 통계 다시 조회</button>
      </>}
      <a className="region-source" href={summary.source_url} target="_blank" rel="noreferrer">경기기후플랫폼 · 행정동 기준 2025.06.30</a>
    </div>;
  }
  const generation = summary.generation;
  return <div className="region-solar-content">
    <h4>{region.district} {region.legal || region.administrative}</h4>
    <p className="rank-note">법정동 기준 · 설치된 태양광 설비</p>
    {generation && <div className="region-solar-total">
      <span>연간 발전예측량</span><strong>{gwh(generation.annual_kwh, 1e6)}</strong>
      <dl className="selected-site-metrics">
        <div><dt>패널 면적</dt><dd>{generation.panel_area_m2 == null ? "자료 없음" : `${num(generation.panel_area_m2 / 10000, 2)} ha`}</dd></div>
        <div><dt>{generation.rank_area ? `${generation.rank_area} 내` : "지역 내"} 순위</dt><dd>{generation.rank == null ? "자료 없음" : `${num(generation.rank)}위`}</dd></div>
      </dl>
    </div>}
    {summary.generation_mix.length > 0 && <div className="region-solar-chart">
      <h5>설치 유형별 연간 발전예측량</h5>
      <StatBars divisor={1e6} rows={summary.generation_mix.map((row) => ({ name: row.name, value: row.annual_kwh }))} />
    </div>}
    {!generation && !summary.generation_mix.length && <>
      <p className="region-empty">선택한 위치의 법정동 발전현황을 확인하지 못했습니다.</p>
      <button type="button" className="btn" onClick={onRetry}>지역 통계 다시 조회</button>
    </>}
    <a className="region-source" href={summary.source_url} target="_blank" rel="noreferrer">경기기후플랫폼 · 태양광 발전현황</a>
  </div>;
}
