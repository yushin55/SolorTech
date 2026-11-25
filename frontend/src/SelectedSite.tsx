import { useEffect, useState } from "react";
import { api, num } from "./api";
import type { Candidate, Design, Run, SiteInfo, SiteType, WaterBody } from "./types";
import RegionalSolar from "./RegionalSolar";
import SiteSolar from "./SiteSolar";
import type { RegionalLocation, RegionalSummary } from "./RegionalSolar";

type Props = {
  site: WaterBody | null;
  regionPoint: { latitude: number; longitude: number } | null;
  siteType: SiteType;
  savedName?: string;
  savedCandidate?: Candidate | null;
  savedDesign?: Design;
  loading: boolean;
  error: string;
  run: Run | null;
  stale: boolean;
  pending: boolean;
  preparing: boolean;
  onContinue?: (site: WaterBody) => Promise<void>;
  onClose: () => void;
  onZoom: () => void;
  onOpenGyeonggi: () => void;
  tab: SiteTab;
  onTab: (tab: SiteTab) => void;
  summaryOnly?: boolean;
};
const roofLabels: Record<string, string> = { flat: "평지붕", gabled: "박공지붕", hipped: "우진각지붕", skillion: "외쪽지붕", pyramidal: "모임지붕", dome: "돔 지붕" };
const tabs = [
  { id: "overview", label: "부지 정보" },
  { id: "potential", label: "잠재량" },
  { id: "generation", label: "발전현황" },
] as const;
export type SiteTab = typeof tabs[number]["id"];

export default function SelectedSite({ site, regionPoint, siteType, savedName, savedCandidate, savedDesign, loading, error, run, stale, pending, preparing,
  onContinue, onClose, onZoom, onOpenGyeonggi, tab, onTab, summaryOnly = false }: Props) {
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [location, setLocation] = useState<RegionalLocation | null>(null);
  const [summary, setSummary] = useState<RegionalSummary | null>(null);
  const [continueError, setContinueError] = useState("");
  const [retry, setRetry] = useState(0);
  const { latitude, longitude } = site || regionPoint || {};
  useEffect(() => {
    setInfo(null);
    setInfoError("");
    setLocation(null);
    setSummary(null);
    if (latitude == null || longitude == null) return;
    if (latitude < 33 || latitude > 39 || longitude < 124 || longitude > 132) {
      setLocation({ status: "outside", location: null });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const query = `latitude=${latitude}&longitude=${longitude}`;
    void api<SiteInfo>(`/guideline/site?${query}`, { signal })
      .then((value) => { if (!signal.aborted) setInfo(value); })
      .catch(() => { if (!signal.aborted) setInfoError("위치의 기상·입지 정보를 불러오지 못했습니다."); });
    void (async () => {
      try {
        const position = await api<RegionalLocation>(`/solar-region/location?${query}`, { signal });
        if (signal.aborted) return;
        setLocation(position);
        if (position.status !== "available") return;
        const data = await api<RegionalSummary>(`/solar-region?${query}`, { signal });
        if (!signal.aborted) setSummary(data);
      } catch {
        if (!signal.aborted) setLocation((current) => ({ status: "unavailable", location: current?.location || null }));
      }
    })();
    return () => controller.abort();
  }, [latitude, longitude, retry]);
  const building = siteType === "building";
  const noun = building ? "건축물" : siteType === "floating" ? "수면" : "지상 부지";
  const region = location?.location;
  const neighborhood = region?.administrative || region?.legal;
  const exactRegionName = [region?.district, neighborhood].filter(Boolean).join(" ");
  const approximateName = info?.nearest_city ? `${info.nearest_city} 인근` : "";
  const positionName = exactRegionName || approximateName;
  const title = site?.name || savedName || (site ? `${neighborhood || region?.district || approximateName || "선택한"} ${noun}` : positionName || "선택한 지역");
  const hasSelection = !!site || (!!regionPoint && !loading);
  const result = run?.result;
  return <section className={`selected-site${summaryOnly ? " climate-summary-content" : ""}`} aria-label={summaryOnly ? "태양광 분석 요약" : "선택 위치 정보"} aria-live="polite">
    <div className="selected-site-heading">
      <span className="selected-site-kicker">{summaryOnly ? tab === "generation" ? "태양광 발전현황" : "태양광 잠재량" : site ? `선택한 ${noun}` : regionPoint ? "지역 태양광" : "지도에서 대상 선택"}</span>
      {!summaryOnly && (site || regionPoint) && <button className="close" aria-label="선택 해제" disabled={preparing} onClick={onClose}>×</button>}
    </div>
    {loading && <div className="selected-site-empty" role="status"><span className="spinner" /><strong>선택한 위치를 확인하고 있습니다</strong></div>}
    {hasSelection && <>
      <h3>{title}</h3>
      {positionName && site && <p className="selected-site-address">{positionName}</p>}
      {site?.building_info?.address && <p className="selected-site-address">{site.building_info.address}</p>}
      {!summaryOnly && <nav className="region-solar-tabs" aria-label="선택 위치 표시">
        {tabs.filter((item) => site || item.id !== "overview").map((item) => <button type="button" key={item.id}
          aria-pressed={tab === item.id} onClick={() => onTab(item.id)}>{item.label}</button>)}
      </nav>}
    </>}
    {hasSelection && (tab === "potential" || tab === "generation") && <>
      <SiteSolar tab={tab} site={site} point={regionPoint} siteType={siteType} candidate={savedCandidate}
        design={savedDesign} />
      {summary?.status === "available" && (tab === "potential" ? summary.potential : summary.generation || summary.generation_mix.length > 0) &&
        <details className="official-solar-stats"><summary>경기도 공식 지역 집계 보기</summary>
          <RegionalSolar tab={tab} location={location} summary={summary}
            onOpenGyeonggi={onOpenGyeonggi} onRetry={() => setRetry((old) => old + 1)} />
        </details>}
    </>}
    {site && tab === "overview" && <>
      <dl className="selected-site-facts">
        <div><dt>{building ? "건축물 용도" : "대상 유형"}</dt><dd>{site.kind}</dd></div>
        <div><dt>{building ? "지도상 지붕 면적" : "경계 면적"}</dt><dd>{num(site.area_m2, 1)} m²</dd></div>
        {building && <>
          <div><dt>층수</dt><dd>{site.building_info?.levels ? `${site.building_info.levels}층` : "미등록"}</dd></div>
          <div><dt>건물 높이</dt><dd>{site.building_info?.height ? (/m$/i.test(site.building_info.height) ? site.building_info.height : `${site.building_info.height} m`) : "미등록"}</dd></div>
          <div><dt>지붕 형태</dt><dd>{site.building_info?.roof_shape ? roofLabels[site.building_info.roof_shape] || site.building_info.roof_shape : "미등록"}</dd></div>
        </>}
        <div><dt>위도 / 경도</dt><dd>{num(site.latitude, 6)} / {num(site.longitude, 6)}</dd></div>
      </dl>
      <div className="selected-site-prediction">
        <h4>저장된 발전량·사업성</h4>
        {result && run ? <>
          <p className="rank-note">{run.snapshot.design.name}{stale && " · 이전 조건으로 계산한 결과"}</p>
          <dl className="selected-site-metrics">
            <div><dt>연간 발전량</dt><dd>{num(result.annual_kwh / 1000, 1)} <small>MWh/년</small></dd></div>
            <div><dt>설치용량</dt><dd>{num(result.capacity_dc_kw, 1)} <small>kW</small></dd></div>
            <div><dt>편익/비용 B/C</dt><dd>{num(result.economics?.bc, 2)}</dd></div>
            <div><dt>순현재가치 NPV</dt><dd>{num(result.economics?.npv != null ? result.economics.npv / 10000 : null, 0)} <small>만 원</small></dd></div>
          </dl>
        </> : <p>이 부지에 저장된 분석 결과가 없습니다.</p>}
        {pending && <p className="rank-note" role="status">이 부지의 분석이 진행 중입니다.</p>}
      </div>
      {summary && (summary.potential || summary.generation) && <dl className="selected-site-facts region-overview">
        {summary.potential?.theoretical.roof_mwh != null && <div><dt>행정동 이론적 옥상 잠재량</dt>
          <dd>{num(summary.potential.theoretical.roof_mwh / 1000, 2)} GWh</dd></div>}
        {summary.generation?.annual_kwh != null && <div><dt>법정동 연간 발전예측량</dt>
          <dd>{num(summary.generation.annual_kwh / 1e6, 2)} GWh</dd></div>}
      </dl>}
      {continueError && <p className="selected-site-error" role="alert">{continueError}</p>}
      {onContinue && <button className="btn primary block" disabled={preparing} onClick={async () => {
        setContinueError("");
        try { await onContinue(site.name || !positionName ? site : { ...site, name: title }); }
        catch (cause) { setContinueError(cause instanceof Error ? cause.message : "설계 단계로 이동하지 못했습니다."); }
      }}>{preparing ? "설계 준비 중…" : "다음 · 설계 조건 입력"}</button>}
      <dl className="selected-site-facts">
        <div><dt>기상 관측소</dt><dd>{info?.weather_station ? `${info.weather_station.name} · ${num(info.weather_station.distance_km, 1)} km` : infoError ? "미확인" : info ? "미제공" : "확인 중…"}</dd></div>
        <div><dt>권장 경사각</dt><dd>{info?.optimal_tilt != null ? `${num(info.optimal_tilt, 1)}°` : infoError ? "미확인" : info ? "미제공" : "확인 중…"}</dd></div>
      </dl>
      {infoError && <p className="rank-note">{infoError}</p>}
      <p className="rank-note">{site.data_source || "© OpenStreetMap contributors"} · 면적은 수평 투영 기준입니다.</p>
    </>}
    {!hasSelection && !loading && <div className="selected-site-empty"><strong>지도에서 부지 또는 지역을 클릭하세요</strong>
      <button className="btn block" onClick={onZoom}>부지 경계가 보이도록 확대</button></div>}
    {error && <p className="rank-note">{error}</p>}
  </section>;
}
