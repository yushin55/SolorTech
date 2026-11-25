import { useEffect, useState } from "react";
import { api, num } from "./api";
import SolarBars from "./SolarBars";

type Year = { year: number; recorded_kwh: number; observed_periods: number; expected_periods: number;
  resolution: "daily" | "monthly"; complete: boolean; start: string; end: string; monthly_kwh?: (number | null)[] };
type OperatingStatus = {
  scope_label: string;
  notice: string;
  facilities: { id: string; name: string; source: string; capacity_kw: number | null; location_notice: string | null;
    series: { id: string; label: string; unit_notice: string | null; years: Year[] }[] }[];
};

export default function OperatingSolar({ payload }: { payload: string }) {
  const [status, setStatus] = useState<OperatingStatus | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selectedYears, setSelectedYears] = useState<Record<string, number>>({});
  useEffect(() => {
    setStatus(null);
    setError("");
    const controller = new AbortController();
    void api<OperatingStatus>("/solar-status", { method: "POST", body: payload, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.facilities)) throw new Error("운영실적 응답을 확인하지 못했습니다.");
        setStatus(data);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [payload, retry]);
  return <div className="region-solar-content operating-solar">
    <h4>기존 태양광 설치·운영 현황</h4>
    <p className="site-solar-badge">등록된 기존 시설 · 기록된 실적</p>
    {error ? <p role="alert">운영실적을 불러오지 못했습니다. {error}</p>
      : !status ? <p role="status">등록 시설과 운영실적을 확인하는 중…</p> : <>
        <p className="rank-note">{status.scope_label}</p>
        {!status.facilities.length && <p className="region-empty">이 범위에 연결된 기존 태양광 시설 자료가 없습니다. 설치 예정 후보지의 예측은 잠재량 탭에서 확인하세요.</p>}
        {status.facilities.map((facility) => <section className="operating-facility" key={facility.id}>
          <h5>{facility.name}</h5>
          <dl className="selected-site-metrics"><div><dt>기존 설치용량</dt><dd>{facility.capacity_kw == null ? "미등록" : <>{num(facility.capacity_kw, 1)} <small>kW</small></>}</dd></div></dl>
          <p className="rank-note">{facility.source}</p>
          {!facility.series.some((series) => series.years.length) && <p>설비 제원만 등록되어 있습니다. 연결된 발전실적은 없습니다.</p>}
          {facility.series.filter((series) => series.years.length > 0).map((series) => <div key={series.id}>
            <h5>{series.label}</h5>
            <label className="solar-year-select">실적 연도<select aria-label={`${facility.name} ${series.label} 실적 연도`}
              value={selectedYears[series.id] || series.years[0].year} onChange={(e) => setSelectedYears((old) => ({ ...old, [series.id]: Number(e.target.value) }))}>
              {series.years.map((year) => <option key={year.year} value={year.year}>{year.year}년{year.complete ? "" : " · 부분 기간"}</option>)}
            </select></label>
            {(() => { const year = series.years.find((item) => item.year === selectedYears[series.id]) || series.years[0];
              return <><div className="solar-headline actual"><span>{year.year}년 기록 누적량</span><strong>{num(year.recorded_kwh / 1000, 1)}<small>MWh</small></strong></div>
                {!!year.monthly_kwh?.length && <SolarBars title={`${year.year}년 월별 ${series.label}`} values={year.monthly_kwh} />}</>; })()}
            <table className="region-solar-table"><thead><tr><th scope="col">연도</th><th scope="col">기록 누적량</th><th scope="col">자료 범위</th></tr></thead>
              <tbody>{series.years.map((year) => <tr key={year.year}><th scope="row">{year.year}</th>
                <td>{num(year.recorded_kwh / 1000, 1)} MWh</td>
                <td>{year.complete ? "연간 전체" : "부분 기간"}<br />{year.observed_periods}/{year.expected_periods}{year.resolution === "daily" ? "일" : "개월"}</td>
              </tr>)}</tbody>
            </table>
            <p className="rank-note">최근 기록: {series.years[0].start} ~ {series.years[0].end}. 결측 기간은 추정하거나 연간으로 환산하지 않았습니다.</p>
            {series.unit_notice && <p className="rank-note">{series.unit_notice}</p>}
          </div>)}
          {facility.location_notice && <p className="rank-note">위치 근거: {facility.location_notice}</p>}
        </section>)}
        <p className="rank-note">{status.notice}</p>
      </>}
    {error && <button className="btn" onClick={() => setRetry((old) => old + 1)}>운영실적 다시 조회</button>}
  </div>;
}
