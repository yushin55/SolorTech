import { useEffect, useState } from "react";
import { api, num } from "./api";
import type { Candidate, Result, Settings, SizingPreview, WeatherSelection } from "./types";

export function WeatherDetails({ value }: { value: WeatherSelection }) {
  return <div className="feasibility-detail">
    <h4>좌표로 자동 연결한 기상 관측소</h4>
    <p>가장 가까운 ASOS: <b>{value.nearest.name} ({value.nearest.stn})</b> · {num(value.nearest.distance_km, 2)} km</p>
    <p>발전량 예측에 사용할 관측소: <b>{value.selected ? `${value.selected.name} (${value.selected.stn}) · ${num(value.selected.distance_km, 2)} km` : "관측자료 없음 · ERA5 사용"}</b></p>
    {value.selected && value.selected.stn !== value.nearest.stn && <p className="inline-warning">최인접 관측소의 일자료가 없어, 자료를 확보한 관측소 중 가장 가까운 곳을 연결했습니다.</p>}
    {value.selected && value.selected.distance_km > 60 && <p className="inline-warning">연결 관측소가 60 km 이상 떨어져 있어 현지 기상 대표성 확인이 필요합니다.</p>}
    {value.profile && <p className="hint">관측 기간 {value.profile.period} · {value.profile.source}</p>}
    <p className="hint">{value.basis}</p>
    <p className="hint">{value.selection_basis} · <a href={value.coordinate_source} target="_blank" rel="noreferrer">기상청 공식 좌표</a> ({value.coordinate_date})</p>
  </div>;
}

export function CandidateWeather({ candidate }: { candidate: Pick<Candidate, "latitude" | "longitude"> }) {
  const [value, setValue] = useState<WeatherSelection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setValue(null); setError("");
    const timer = setTimeout(() => {
      void api<WeatherSelection>(`/weather/nearest?latitude=${candidate.latitude}&longitude=${candidate.longitude}`)
        .then((next) => { if (!cancelled) setValue(next); })
        .catch((e: Error) => { if (!cancelled) setError(e.message); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [candidate.latitude, candidate.longitude]);
  return <div aria-live="polite">
    <p>선택 좌표: 위도 <b>{num(candidate.latitude, 6)}</b> · 경도 <b>{num(candidate.longitude, 6)}</b> (WGS84)</p>
    {error ? <p className="inline-warning">관측소 조회 실패: {error}</p> : value ? <WeatherDetails value={value} /> : <p className="hint">가까운 관측소 확인 중…</p>}
  </div>;
}

const candidateKeys = ["name", "latitude", "longitude", "geometry", "exclusions", "site_type", "grid_point", "cable_distance_m", "water_depth_m", "water_level_m", "boundary_setback_m", "shading_loss_pct", "terrain_slope_deg", "slope_limit_deg", "roof_mount", "roof_tilt_deg", "roof_azimuth_deg", "roof_allowable_load_kg_m2", "roof_system_load_kg_m2", "reference_plant_id", "source"];

export function SizingDetails({ value }: { value: SizingPreview }) {
  return <div className="feasibility-detail">
    <h4>설비용량 계산 {value.legacy ? "" : "미리보기"}</h4>
    {!value.legacy && <>
      <p>최소·면적 산정 수량 <b>{num(value.minimum_modules)}장</b> → 직렬 구성 후 <b>{num(value.module_count)}장 · {num(value.capacity_kw, 3)} kW</b></p>
      {value.target_capacity_kw != null && <p>목표 용량 {num(value.target_capacity_kw, 3)} kW · 실제 설치용량 = {value.module?.power_w} W × {num(value.module_count)}장 ÷ 1,000</p>}
      {value.site_area_m2 != null && <p>입력 면적 {num(value.site_area_m2)} m² · 통로·장애물 여유 면적 {num(value.reserve_pct, 1)}% (사용자 가정)</p>}
      {value.pitch && <p>행간 {num(value.pitch.gap_m, 3)} m · 배치 피치 {num(value.pitch.pitch_m, 3)} m · {value.pitch.basis}</p>}
      {value.module && <p className="hint">{value.module.manufacturer} · {value.module.model} · {value.module.power_w} W · {value.module.width_m} × {value.module.height_m} m<br />출처: {value.module.source}</p>}
    </>}
    <p className="hint">{value.basis}</p>
  </div>;
}

export function CapacityPreview({ candidate, equipment }: { candidate: Candidate; equipment: Settings }) {
  const [value, setValue] = useState<SizingPreview | null>(null);
  const [error, setError] = useState("");
  const signature = JSON.stringify({ candidate: Object.fromEntries(Object.entries(candidate).filter(([key]) => candidateKeys.includes(key))), equipment });
  useEffect(() => {
    let cancelled = false;
    setValue(null); setError("");
    const timer = setTimeout(() => {
      void api<SizingPreview>("/analysis/preview", { method: "POST", body: signature })
        .then((next) => { if (!cancelled) setValue(next); })
        .catch((e: Error) => { if (!cancelled) setError(e.message); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signature]);
  return <div aria-live="polite">{error ? <p className="inline-warning">설비 계산: {error}</p> : value ? <SizingDetails value={value} /> : <p className="hint">설비용량 계산 중…</p>}</div>;
}

export function OrientationComparison({ result }: { result: Result }) {
  if (!result.orientation_comparison) return null;
  return <div className="feasibility-detail">
    <h4>선택 조건별 예상 발전량 비교</h4>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>조건</th><th>경사 / 방위</th><th>연간 예측 kWh</th><th>선택 대비</th></tr></thead><tbody>
      {result.orientation_comparison.map((row) => <tr key={row.label}><td>{row.label}</td><td>{row.tilt}° / {row.azimuth}°</td><td>{num(row.annual_kwh)}</td><td>{num(row.difference_pct, 1)}%</td></tr>)}
    </tbody></table></div>
    <p className="hint">{result.orientation_basis}</p>
  </div>;
}

export function RevenueDetails({ result }: { result: Result }) {
  if (!result.revenue_monthly) return null;
  return <div className="feasibility-detail">
    <h4>월별 예측 발전량과 예상 현금 유입</h4>
    <p>SolarTech 최소 필요 판매단가(참고): <b>{num(result.economics.required_price_per_kwh, 2)}원/kWh</b> · 입력 판매단가의 상하한을 제한하지 않습니다.</p>
    <p className="hint">예측 판매전력량 × 사용자 판매단가 {num(result.economics.effective_price_per_kwh, 2)}원/kWh. 실제 판매실적이 아닙니다. 출력제한·자가소비를 반영하며 자가소비는 연간 사용분을 발전량 비율로 나눈 가정입니다.</p>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>월</th><th>예측 발전량 kWh</th><th>예측 판매량 kWh</th><th>예상 매출·절감액 원</th></tr></thead><tbody>
      {result.revenue_monthly.map((row) => <tr key={row.month}><td>{row.month}월</td><td>{num(row.generation_kwh)}</td><td>{num(row.sales_kwh)}</td><td>{num(row.revenue)}</td></tr>)}
      <tr><th>연간</th><td>{num(result.annual_kwh)}</td><td>{num(result.economics.first_year_sales_kwh)}</td><td>{num(result.economics.first_year_revenue)}</td></tr>
    </tbody></table></div>
    <h4>판매단가 시나리오 비교</h4>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>단가 원/kWh</th><th>첫해 매출 원</th><th>회수기간 년</th><th>기간 순현금이익 원</th><th>NPV 원</th></tr></thead><tbody>
      {result.price_scenarios?.map((row, i) => <tr key={i}><td>{num(row.price_per_kwh, 2)}</td><td>{num(row.annual_revenue)}</td><td>{row.payback_years == null ? "기간 내 미회수" : num(row.payback_years, 1)}</td><td>{num(row.net_profit)}</td><td>{num(row.npv)}</td></tr>)}
    </tbody></table></div>
    <p>사업기간 순현금이익: <b>{num(result.economics.net_profit)}원</b> (초기 투자비·운영비·교체비 차감, 세전·비차입)</p>
  </div>;
}

export function FinancialAssumptions({ result }: { result: Result }) {
  if (!result.financial_assumptions) return null;
  return <div className="feasibility-detail"><h4>계산 가정·단위·출처</h4>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>항목</th><th>가정값</th><th>단위</th><th>출처</th></tr></thead><tbody>
      {result.financial_assumptions.map((row) => <tr key={row.label}><td>{row.label}</td><td>{num(row.value, 2)}</td><td>{row.unit}</td><td>{row.source}</td></tr>)}
      {result.steps.costs.items.map((row) => <tr key={row.key}><td>{row.label}</td><td>{num(row.amount)}</td><td>원 · {row.basis}</td><td>{row.source}</td></tr>)}
    </tbody></table></div>
  </div>;
}
