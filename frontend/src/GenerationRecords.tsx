import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, num } from "./api";
import type { Run } from "./types";

export type GenerationSeries = {
  id: string; name: string; unit_id: string; resolution: "daily" | "monthly"; asset_ids: string[];
  records: number; first: string; last: string; source_files: string[]; value_header: string;
  issues: string[]; capacity_mismatch: boolean; match_basis: string; unit_basis: string; source_url: string | null;
  diagnostics: Record<string, number>;
  months: { period: string; total_value: number | null; records: number; valid_records: number; coverage: number; flagged_records: number; zero_records: number }[];
};
export type GenerationCatalog = {
  archive_file: string; imported_at: string; training_note: string; unit_basis: string; series: GenerationSeries[];
  summary: { added_files: number; duplicate_files: number; source_csv_files: number; series: number; linked_assets: number; daily_records: number; monthly_records: number; conflicting_rows: number };
};
type Observation = { period: string; value: number | null; hours: (number | null)[] | null; flags: string[]; source_refs: { source_file: string; row: number }[] };
type Comparison = { run_id: string; series_id: string; year: number; compatible: boolean; warnings: string[]; excluded_records: number;
  monthly: { period: string; actual_kwh: number | null; model_matched_kwh: number | null; relative_error_pct: number | null; valid_ratio: number }[] };
const diagnosticNames: Record<string, string> = {
  invalid_value: "값 오류", incomplete_hours: "시간별 결측 (일 총량 보존)", hour_total_mismatch: "일 총량·시간 합계 불일치",
  capacity_yield_warning: "현재 설비용량 기준 일 발전량 초과", conflicting_duplicate: "동일 일자·호기 값 충돌",
};

export default function GenerationRecords({ catalog, assetId, runs }: { catalog: GenerationCatalog; assetId?: string; runs: Run[] }) {
  const [seriesId, setSeriesId] = useState("");
  const series = catalog.series.find((s) => s.id === seriesId) || catalog.series.find((s) => assetId && s.asset_ids.includes(assetId)) || catalog.series[0];
  const [year, setYear] = useState(0);
  const years = useMemo(() => series ? [...new Set(series.months.map((m) => Number(m.period.slice(0, 4))))].sort((a, b) => b - a) : [], [series]);
  const selectedYear = years.includes(year) ? year : years.includes(years[0] - 1) ? years[0] - 1 : years[0];
  const [records, setRecords] = useState<Observation[]>([]);
  const [runId, setRunId] = useState("");
  const [assumeKwh, setAssumeKwh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [day, setDay] = useState("");
  useEffect(() => {
    setSeriesId(catalog.series.find((s) => assetId && s.asset_ids.includes(assetId))?.id || "");
  }, [assetId, catalog]);
  useEffect(() => {
    if (!series || !selectedYear) return;
    let active = true;
    setRecords([]); setComparison(null); setError(""); setAssumeKwh(false); setDay("");
    api<{ records: Observation[] }>(`/solartech/generation/${series.id}?year=${selectedYear}`).then((data) => {
      if (active) setRecords(data.records);
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [series?.id, selectedYear]);
  if (!series) return null;
  const months = series.months.filter((m) => Number(m.period.slice(0, 4)) === selectedYear);
  const availableRuns = runs.filter((r) => r.status === "completed" && r.snapshot?.candidate.solartech_asset_id && series.asset_ids.includes(r.snapshot.candidate.solartech_asset_id));
  const selectedRun = availableRuns.find((r) => r.id === runId) || availableRuns[0];
  const observation = records.find((r) => r.period === day);
  return <section className="card stack" aria-label="ZIP 발전실적">
    <div className="card-heading"><h3>ZIP에서 연결한 발전실적</h3><span className="muted">CSV {catalog.summary.source_csv_files}개 · 일 {num(catalog.summary.daily_records)}행 · 월 {num(catalog.summary.monthly_records)}행</span></div>
    <p className="hint">내용이 같은 아산 보고서는 기존 자료를 재사용합니다. {catalog.training_note}</p>
    <div className="fields">
      <label className="field"><span>저장 실적 선택</span><select value={series.id} onChange={(e) => { setSeriesId(e.target.value); setYear(0); }}>
        {catalog.series.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.resolution === "monthly" ? "월별" : `호기 ${s.unit_id || "무표시"}`} {assetId && s.asset_ids.includes(assetId) ? "(선택 발전소 연결)" : ""}</option>)}
      </select></label>
      <label className="field"><span>실적 연도</span><select value={selectedYear} onChange={(e) => setYear(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{y}년</option>)}</select></label>
    </div>
    <p className="hint">{series.first} ~ {series.last} · {num(series.records)}행 · 원본 항목: {series.value_header} · {series.resolution === "monthly" ? "월별 값을 일·시간 자료로 나누지 않습니다." : "일 총량과 1~24시 값을 함께 보존합니다."}</p>
    {assetId && !series.asset_ids.includes(assetId) && <p className="bad">현재 선택 발전소에 자동 연결된 자료가 아닙니다. 자료 자체는 조회할 수 있습니다.</p>}
    {series.issues.map((issue) => <p className="bad" key={issue}>{issue}</p>)}
    {series.capacity_mismatch && <p className="bad">엑셀 설비용량 불일치가 있어 모델 오차 대조는 보류합니다.</p>}
    <div className="chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={months}>
      <CartesianGrid vertical={false} stroke="#eef0f3" /><XAxis dataKey="period" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} />
      <Tooltip formatter={(value) => [num(Number(value), 2), "원본 실적 합계"]} /><Bar dataKey="total_value" name="원본 실적 합계 (단위 미확정)" fill="#2563eb" />
    </BarChart></ResponsiveContainer></div>
    <p className="hint">위 차트는 원본 값의 월별 합계입니다. 빈 값·충돌은 합계에서 제외하며 실제 0은 유지합니다. 단위와 과거 용량 변경은 별도 확인이 필요합니다.</p>
    <div className="table-scroll"><table><thead><tr><th>기간</th><th>원본 실적 합계</th><th>자료 수</th><th>유효 비율</th><th>0 기록</th><th>확인 필요</th></tr></thead><tbody>{months.map((m) => <tr key={m.period}><th>{m.period}</th><td>{num(m.total_value, 2)}</td><td>{m.valid_records} / {m.records}</td><td>{num(m.coverage * 100, 1)}%</td><td>{m.zero_records}</td><td>{m.flagged_records}</td></tr>)}</tbody></table></div>
    {Object.entries(series.diagnostics).length > 0 && <p className="hint">품질 점검: {Object.entries(series.diagnostics).map(([key, value]) => `${diagnosticNames[key] || key} ${num(value)}행`).join(" · ")}</p>}
    <details><summary>저장된 원본 일·월 값과 시간별 값 보기</summary>
      <div className="table-scroll solartech-table"><table><thead><tr><th>날짜 / 월</th><th>원본 값</th><th>품질 표시</th><th>원본 행</th></tr></thead><tbody>{records.map((r) => <tr key={r.period}>
        <th>{r.hours ? <button className="link" onClick={() => setDay(r.period)}>{r.period}</button> : r.period}</th><td>{num(r.value, 3)}</td><td>{r.flags.map((f) => diagnosticNames[f] || f).join(" · ") || "형식 정상"}</td><td>{r.source_refs.map((ref) => ref.row).join(", ")}</td>
      </tr>)}</tbody></table></div>
      {observation?.hours && <div className="table-scroll"><p>{observation.period} · 1~24시 원본 값 (결측은 —)</p><table><tbody><tr>{observation.hours.map((_, i) => <th key={i}>{i + 1}시</th>)}</tr><tr>{observation.hours.map((v, i) => <td key={i}>{num(v, 3)}</td>)}</tr></tbody></table></div>}
    </details>
    <details><summary>완료된 설계안과 같은 기간의 실적 대조</summary>
      <p className="hint">{series.unit_basis}</p>
      {availableRuns.length === 0 ? <p>연결된 엑셀 발전소를 사업성 검토로 가져와 분석을 완료하면 같은 발전소의 실적과 대조할 수 있습니다.</p> : <div className="stack">
        <label className="field"><span>대조할 완료 분석</span><select value={selectedRun?.id || ""} onChange={(e) => { setRunId(e.target.value); setComparison(null); }} disabled={busy}>{availableRuns.map((r) => <option key={r.id} value={r.id}>{r.snapshot.candidate.name} · {r.snapshot.design.name} · {r.created_at.slice(0, 10)}</option>)}</select></label>
        <label><input type="checkbox" checked={assumeKwh} onChange={(e) => { setAssumeKwh(e.target.checked); setComparison(null); }} disabled={busy} /> 원본 발전실적을 kWh로 해석하는 가정으로 대조</label>
        <button className="btn outline" disabled={busy || !assumeKwh || !selectedRun || series.capacity_mismatch} onClick={async () => {
          if (!selectedRun) return;
          setBusy(true); setError(""); setComparison(null);
          const comparingSeries = series.id, comparingRun = selectedRun.id, comparingYear = selectedYear;
          try { setComparison(await api<Comparison>(`/solartech/generation/${comparingSeries}/compare`, { method: "POST", body: JSON.stringify({ run_id: comparingRun, year: comparingYear, assume_kwh: true }) })); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}>{busy ? "해당 연도 기상으로 계산 중…" : "저장 실적과 대조"}</button>
      </div>}
      {comparison && comparison.series_id === series.id && comparison.year === selectedYear && comparison.run_id === selectedRun?.id && <>
        <p>실적과 같은 날짜의 기상으로 다시 계산했습니다. 제외 기록 {comparison.excluded_records}행 · {comparison.compatible ? "설비용량 대조 가능" : "설비 조건 불일치로 오차 산정 불가"}</p>
        <div className="table-scroll"><table><thead><tr><th>기간</th><th>실적 kWh (가정)</th><th>같은 구간 모델 kWh</th><th>오차</th><th>유효 비율</th></tr></thead><tbody>{comparison.monthly.map((m) => <tr key={m.period}><th>{m.period}</th><td>{num(m.actual_kwh)}</td><td>{num(m.model_matched_kwh)}</td><td>{num(m.relative_error_pct, 1)}%</td><td>{num(m.valid_ratio * 100, 1)}%</td></tr>)}</tbody></table></div>
        {comparison.warnings.map((w) => <p className="hint" key={w}>{w}</p>)}
      </>}
    </details>
    {error && <p role="alert" className="bad">{error}</p>}
    <p className="hint solartech-filename">출처: {series.source_files.join(" · ")} · 연결 기준: {series.match_basis}{series.source_url && <> · <a href={series.source_url} target="_blank" rel="noreferrer">공공데이터포털 원문</a></>}</p>
  </section>;
}
