import { useEffect, useMemo, useState } from "react";
import { api, num } from "./api";
import type { Candidate, Design, Run, SiteType } from "./types";
import GenerationRecords from "./GenerationRecords";
import type { GenerationCatalog } from "./GenerationRecords";

export type SolarTechAsset = {
  id: string;
  name: string;
  original_name: string | null;
  address: string | null;
  provider: string | null;
  source_sheet: string;
  source_row: number;
  latitude: number | null;
  longitude: number | null;
  has_coordinates: boolean;
  capacity_kw: number | null;
  module_power_w: number | null;
  module_count: number | null;
  tilt_deg: number | null;
  tilt_raw: string | number | null;
  module_power_raw: string | number | null;
  inverter_capacity_raw: string | number | null;
  inverter_count: number | null;
  calculated_module_capacity_kw: number | null;
  capacity_difference_kw: number | null;
  capacity_mismatch: boolean;
  generation_file: string | null;
  generation_file_referenced: boolean;
  generation_series_ids?: string[];
  issues: string[];
  raw: Record<string, string | number | null>;
};
type Registry = {
  source_file: string | null;
  imported_at?: string;
  sha256?: string;
  generation_note?: string;
  generation_catalog?: GenerationCatalog;
  assets: SolarTechAsset[];
  summary: { plants: number; with_coordinates: number; generation_references: number; capacity_mismatches: number };
};
export type AssetImportResult = { candidate: Candidate; design: Design | null; already_imported: boolean };
export type AssetInputs = {
  site_type: SiteType;
  latitude: number;
  longitude: number;
  capacity_kw: number;
  module_power_w: number;
  tilt: number;
  azimuth: number;
};

export default function SolarTech({ onImport, runs = [] }: {
  onImport: (assetId: string, values: AssetInputs) => Promise<void>;
  runs?: Run[];
}) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [importAsset, setImportAsset] = useState<SolarTechAsset | null>(null);
  useEffect(() => {
    let active = true;
    api<Registry>("/solartech/assets").then((data) => {
      if (active) { setRegistry(data); setSelectedId(data.assets[0]?.id || ""); }
    }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);
  const rows = useMemo(() => registry?.assets.filter((a) =>
    `${a.name} ${a.original_name || ""} ${a.address || ""} ${a.provider || ""}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter === "all" || (filter === "coordinates" && a.has_coordinates) ||
     (filter === "mismatch" && a.capacity_mismatch) || (filter === "generation" && a.generation_file_referenced) ||
     (filter === "linked" && !!a.generation_series_ids?.length)),
  ) || [], [registry, query, filter]);
  const selected = rows.find((a) => a.id === selectedId) || rows[0];
  if (error) return <div className="banner error" role="alert">{error}</div>;
  if (!registry) return <div className="card empty">엑셀 설비정보를 불러오는 중…</div>;
  if (!registry.assets.length) return <div className="card empty"><h3>가져온 엑셀 설비정보가 없습니다</h3><p>SolarTech 엑셀을 가져오면 이곳에서 발전소별 제원을 확인할 수 있습니다.</p></div>;
  return <div className="stack">
    <div className="card lead">
      <h3>엑셀 발전소 정보를 사업성 검토에 연결합니다</h3>
      <p>발전소를 선택하고 ‘사업성 검토로 가져오기’를 누르면 현재 프로젝트에 후보지와 설계안을 만듭니다. 원본의 빈 값·범위 표기는 그대로 보존하며, 필요한 위치와 설치 조건을 확인한 후 적용합니다.</p>
      <p className="hint">원본: {registry.source_file} · {registry.generation_note}</p>
    </div>
    <div className="kpis">
      <div><span>등록 발전소</span><strong>{registry.summary.plants}<small>곳</small></strong><small>엑셀의 실제 데이터 행</small></div>
      <div><span>좌표 있는 발전소</span><strong>{registry.summary.with_coordinates}<small>곳</small></strong><small>중복 좌표는 별도 확인</small></div>
      <div><span>발전량 파일 참조</span><strong>{registry.summary.generation_references}<small>곳</small></strong><small>{registry.generation_catalog ? `ZIP 실적 연결 ${registry.generation_catalog.summary.linked_assets}곳` : "엑셀에 발전량 시계열 미포함"}</small></div>
      <div><span>용량 불일치</span><strong>{registry.summary.capacity_mismatches}<small>곳</small></strong><small>전체 kW와 모듈 W×수량 비교</small></div>
    </div>
    <div className="card">
      <div className="solartech-filters">
        <label className="field"><span>발전소 검색</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름·주소·출처" /></label>
        <label className="field"><span>표시 조건</span><select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">전체 발전소</option><option value="coordinates">좌표 있음</option><option value="mismatch">용량 불일치</option><option value="generation">발전량 파일 참조 있음</option><option value="linked">ZIP 실적 연결됨</option>
        </select></label>
        <span className="muted">{rows.length}곳 표시</span>
      </div>
      <div className="table-scroll solartech-table"><table className="selectable"><thead><tr>
        <th>발전소</th><th>전체 용량 kW</th><th>모듈 W × 수량</th><th>설치각</th><th>좌표</th><th>용량 점검</th><th>ZIP 실적</th>
      </tr></thead><tbody>{rows.map((a) => <tr key={a.id} className={a.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(a.id)}>
        <th><button className="link" onClick={() => setSelectedId(a.id)}>{a.name}</button></th>
        <td>{num(a.capacity_kw, 3)}</td><td>{a.module_power_w == null ? a.module_power_raw || "—" : `${num(a.module_power_w)} × ${num(a.module_count)}`}</td>
        <td>{a.tilt_raw ?? "미입력"}</td><td>{a.has_coordinates ? "있음" : "미입력"}</td>
        <td className={a.capacity_mismatch ? "bad" : ""}>{a.capacity_mismatch ? `차이 ${num(a.capacity_difference_kw, 3)} kW` : a.calculated_module_capacity_kw == null ? "계산 불가" : "일치"}</td>
        <td>{a.generation_series_ids?.length ? "연결됨" : "없음·확인 필요"}</td>
      </tr>)}</tbody></table></div>
      {!rows.length && <p className="inline-empty">검색 조건에 맞는 발전소가 없습니다.</p>}
    </div>
    {selected && <div className="card">
      <div className="card-heading"><h3>{selected.name}</h3><button className="btn primary" onClick={() => setImportAsset(selected)}>사업성 검토로 가져오기</button></div>
      <p>{selected.address || "주소 미입력"}</p>
      <p className="hint">출처: {registry.source_file} · {selected.source_sheet} · {selected.source_row}행 · {selected.provider || "출처 미입력"}</p>
      <dl className="facts">
        <div><dt>모듈 합산 용량</dt><dd>{num(selected.calculated_module_capacity_kw, 3)} kW</dd></div>
        <div><dt>인버터 원본 제원</dt><dd>{selected.inverter_capacity_raw ?? "미입력"}{selected.inverter_count != null && ` kW × ${num(selected.inverter_count)}대`}</dd></div>
        <div><dt>발전량 파일 참조</dt><dd className="solartech-filename">{selected.generation_file || "미입력"}</dd></div>
      </dl>
      {selected.issues.length > 0 && <ul className="solartech-issues">{selected.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      <details><summary>원본 제원 전체 보기 (34개 열)</summary><div className="table-scroll"><table><tbody>{Object.entries(selected.raw).map(([key, value]) => <tr key={key}><th>{key}</th><td>{value ?? "미입력"}</td></tr>)}</tbody></table></div></details>
    </div>}
    {registry.generation_catalog && <GenerationRecords catalog={registry.generation_catalog} assetId={selected?.id} runs={runs} />}
    {importAsset && <AssetForm key={importAsset.id} asset={importAsset} onClose={() => setImportAsset(null)} onSubmit={onImport} />}
  </div>;
}

function AssetForm({ asset, onClose, onSubmit }: {
  asset: SolarTechAsset;
  onClose: () => void;
  onSubmit: (id: string, values: AssetInputs) => Promise<void>;
}) {
  const [siteType, setSiteType] = useState("");
  const [values, setValues] = useState<Record<string, string>>({
    latitude: asset.has_coordinates ? String(asset.latitude) : "",
    longitude: asset.has_coordinates ? String(asset.longitude) : "",
    capacity_kw: asset.capacity_kw == null ? "" : String(asset.capacity_kw),
    module_power_w: asset.module_power_w == null ? "" : String(asset.module_power_w),
    tilt: asset.tilt_deg == null ? "" : String(asset.tilt_deg),
    azimuth: "180",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = [
    ["latitude", "위도", -89, 89], ["longitude", "경도", -180, 180],
    ["capacity_kw", "검토 설비용량 (kW)", .001, 400000], ["module_power_w", "단일 모듈 출력 (W)", 1, 2000],
    ["tilt", "설치각 (°)", 0, 90], ["azimuth", "방위각 (° · 기본 180은 정남향 가정)", 0, 360],
  ] as const;
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="solartech-import-title" onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}>
    <div className="modal-heading"><h2 id="solartech-import-title">{asset.name} 검토 조건 확인</h2><button className="close" disabled={busy} onClick={onClose} aria-label="닫기">×</button></div>
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true); setError("");
      try {
        await onSubmit(asset.id, { site_type: siteType as SiteType, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)])) } as AssetInputs);
        onClose();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>
      <p>원본에 설치장소 유형이 없어 직접 선택해야 합니다. 좌표·용량·설치각을 확인하세요. 이미 가져온 발전소는 기존 후보지를 엽니다.</p>
      <label className="field"><span>설치장소 유형</span><select autoFocus required value={siteType} onChange={(e) => setSiteType(e.target.value)} disabled={busy}>
        <option value="">유형 선택</option><option value="land">육상</option><option value="rooftop">건축물 (지붕·옥상)</option><option value="floating">수상</option><option value="plant">정수장 부지</option><option value="basin">침전지 상부</option>
      </select></label>
      <div className="fields">{fields.map(([key, label, min, max]) => <label key={key} className="field"><span>{label}</span><input required type="number" min={min} max={max} step="any" disabled={busy} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></label>)}</div>
      {asset.capacity_mismatch && <p className="bad">원본 용량 차이 {num(asset.capacity_difference_kw, 3)} kW. 전체 용량과 모듈 합산 용량 중 어떤 값을 사용할지 확인하세요.</p>}
      <p className="hint">확인한 용량은 목표 용량으로 적용되며 직렬 단위로 올림될 수 있습니다. 원본에 없는 모듈 치수·전기특성·손실과 인버터 효율·구성은 기본 가정입니다. 가격은 가이드라인 환산값입니다. 가져온 후 ② 기자재·④ 공사비에서 수정하세요. 경계가 없어 실제 배치 검증은 수행하지 않으며, 발전량은 물리 모델로 계산합니다. 혼합 모듈은 대표 출력값을 확인해 입력하세요.</p>
      {error && <p className="bad" role="alert">{error}</p>}
      <button className="btn primary block" disabled={busy} type="submit">{busy ? "가져오는 중…" : "확인한 조건으로 가져오기"}</button>
    </form>
  </section></div>;
}
