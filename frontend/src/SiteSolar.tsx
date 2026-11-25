import { useEffect, useState } from "react";
import { api, num } from "./api";
import type { Candidate, Design, SiteType, WaterBody } from "./types";
import OperatingSolar from "./OperatingSolar";
import { solarTarget } from "./solarInputs";
import SolarBars from "./SolarBars";

type Estimate = {
  status: "available" | "unavailable";
  specific_yield?: number | null;
  capacity_dc_kw?: number | null;
  annual_kwh?: number | null;
  module_count?: number | null;
  usable_area_m2?: number | null;
  monthly_kwh?: number[];
  capacity_basis?: string;
  notice: string;
  references: { id: string; name: string; distance_km: number; specific_yield: number; data_kind: string; first_date: string; last_date: string }[];
};
type Props = {
  tab: "potential" | "generation";
  site: WaterBody | null;
  point: { latitude: number; longitude: number } | null;
  siteType: SiteType;
  candidate?: Candidate | null;
  design?: Design;
};

export default function SiteSolar(props: Props) {
  const target = solarTarget(props.candidate, props.site, props.point, props.siteType);
  return props.tab === "generation" ? <OperatingSolar payload={JSON.stringify({ candidate: target })} />
    : <PotentialSolar payload={JSON.stringify({ candidate: target, equipment: props.design?.equipment || null })} />;
}

function PotentialSolar({ payload }: { payload: string }) {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setEstimate(null);
    setError("");
    const controller = new AbortController();
    void api<Estimate>("/solar-potential", { method: "POST", body: payload, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!["available", "unavailable"].includes(data.status)) throw new Error("잠재량 응답을 확인하지 못했습니다.");
        setEstimate(data);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [payload, retry]);
  return <div className="region-solar-content site-solar-estimate">
    <h4>선택 부지의 설치 잠재량</h4>
    <p className="site-solar-badge">부지 면적 기반 · 설치 시나리오</p>
    <p className="rank-note">선택한 부지에 태양광을 배치했을 때의 개략 규모입니다. 현재 설치된 시설의 실적은 발전현황에서 확인합니다.</p>
    {error ? <p role="alert">잠재량을 계산하지 못했습니다. {error}</p>
      : !estimate ? <p role="status">부지 면적과 등록 운영실적으로 잠재량 계산 중…</p>
      : estimate.status === "unavailable" ? <p>{estimate.notice}</p> : <>
        {estimate.annual_kwh != null && <div className="solar-headline"><span>잠재 연간 발전량</span>
          <strong>{num(estimate.annual_kwh / 1000, 1)}<small>MWh/년</small></strong></div>}
        <dl className="selected-site-metrics">
          <div><dt>잠재 설치용량</dt><dd>{estimate.capacity_dc_kw == null ? "부지 면적 입력 필요" : <>{num(estimate.capacity_dc_kw, 1)} <small>kW</small></>}</dd></div>
          {estimate.annual_kwh == null && <div><dt>잠재 연간 발전량</dt><dd>산정 자료 필요</dd></div>}
          {estimate.usable_area_m2 != null && <div><dt>경계 내 유효면적</dt><dd>{num(estimate.usable_area_m2, 1)} <small>m²</small></dd></div>}
          {estimate.module_count != null && <div><dt>배치 가능 모듈 수</dt><dd>{num(estimate.module_count)} <small>장</small></dd></div>}
          <div><dt>발전량 추정 원단위</dt><dd>{num(estimate.specific_yield, 1)} <small>kWh/kW·년</small></dd></div>
        </dl>
        <p className="rank-note">{estimate.capacity_basis}</p>
        {!!estimate.monthly_kwh?.length && <SolarBars title="월별 잠재 발전량" values={estimate.monthly_kwh} estimated />}
        {estimate.capacity_dc_kw == null && <p className="rank-note">지도에서 경계를 선택하거나 설계에 부지 면적을 입력하세요. 목표 용량·모듈 수량만으로 부지 잠재량을 정하지 않습니다.</p>}
        <p className="rank-note">{estimate.notice}</p>
      </>}
    {!!estimate?.references.length && <details className="site-solar-references">
      <summary>발전량 원단위에 사용한 참고 시설 {estimate.references.length}곳</summary>
      <ul>{estimate.references.map((row) => <li key={row.id}><b>{row.name}</b><span>{num(row.distance_km, 1)} km · {num(row.specific_yield, 0)} kWh/kW·년</span>
        <small>{row.data_kind === "generation" ? "발전량" : "전력거래량"} · {row.first_date} ~ {row.last_date}</small></li>)}</ul>
    </details>}
    {(error || estimate?.status === "unavailable") && <button className="btn" onClick={() => setRetry((old) => old + 1)}>잠재량 다시 계산</button>}
  </div>;
}
