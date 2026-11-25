import { useEffect, useState } from "react";
import * as L from "leaflet";
import type { Feature } from "geojson";
import { api } from "./api";
import type { Polygon } from "./types";

type Layer = { id: string; label: string; color: string };
type Catalog = { configured: boolean; source: string; source_url: string; notice: string; layers: Layer[] };
type MapData = Catalog & { status: string; warning: string | null; results: { id: string; complete: boolean; features: Feature[] }[] };
type Check = { status: string; warning: string | null; basis?: string; items: (Layer & { status: "overlap" | "clear" | "unknown" })[] };
export type RegulationTarget = { name: string; latitude: number; longitude: number; geometry: Polygon | null };

export default function Regulations({ map, target, hiddenPanel = false, showLayers = false }: {
  map: L.Map | null; target: RegulationTarget | null; hiddenPanel?: boolean; showLayers?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [hidden, setHidden] = useState<string[]>([]);
  const [opacity, setOpacity] = useState(50);
  const [data, setData] = useState<MapData | null>(null);
  const [mapStatus, setMapStatus] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const signature = JSON.stringify(target);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<Catalog>("/regulations/catalog", { signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.layers)) throw new Error("규제자료 목록을 확인하지 못했습니다.");
        if (!controller.signal.aborted) setCatalog(result);
      }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    setCheck(null);
    if (!target || !catalog?.configured) return;
    const controller = new AbortController();
    setError("");
    void api<Check>("/regulations/check", {
      method: "POST", body: JSON.stringify(target), signal: controller.signal,
    }).then((result) => { if (!controller.signal.aborted) setCheck(result); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [signature, catalog?.configured, retry]);

  useEffect(() => {
    if (!map || !catalog?.configured || !enabled) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => {
      controller?.abort();
      clearTimeout(timer);
      setData(null);
      const b = map.getBounds();
      if (map.getZoom() < 11 || b.getEast() - b.getWest() > .299 || b.getNorth() - b.getSouth() > .199) {
        setMapStatus("규제지역을 보려면 지도를 더 확대하세요.");
        return;
      }
      setMapStatus("규제지역 경계를 불러오는 중…");
      timer = setTimeout(() => {
        controller = new AbortController();
        const signal = controller.signal;
        const query = new URLSearchParams({ west: String(b.getWest()), south: String(b.getSouth()), east: String(b.getEast()), north: String(b.getNorth()) });
        void api<MapData>(`/regulations?${query}`, { signal }).then((result) => {
          if (signal.aborted) return;
          setData(result);
          setMapStatus(result.warning || "현재 지도 범위의 규제지역을 표시합니다.");
        }).catch((e) => { if (!signal.aborted) setMapStatus(`규제 경계 미확인 · ${e.message}`); });
      }, 650);
    };
    map.on("moveend", load);
    load();
    return () => { clearTimeout(timer); controller?.abort(); map.off("moveend", load); };
  }, [map, catalog?.configured, enabled, retry]);

  useEffect(() => {
    if (!map || !enabled || !data) return;
    const group = L.layerGroup().addTo(map);
    for (const row of data.results) {
      if (hidden.includes(row.id)) continue;
      const color = catalog?.layers.find((layer) => layer.id === row.id)?.color || "#ef4444";
      for (const feature of row.features) L.geoJSON(feature, {
        pane: "regulations", interactive: false,
        style: { color, fillColor: color, weight: 1.5, fillOpacity: opacity * .0044, dashArray: "5 3" },
      }).addTo(group);
    }
    return () => { group.remove(); };
  }, [map, data, enabled, hidden, catalog, opacity]);

  const overlaps = check?.items.filter((item) => item.status === "overlap") || [];
  const unknown = check?.items.filter((item) => item.status === "unknown").length || 0;
  return (
    <section className="regulation-panel" aria-label="규제지역 확인" hidden={hiddenPanel}>
      <div className="rank-head"><h4>규제요인</h4><span>경기도 공식 자료</span></div>
      <label className="regulation-switch">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />규제지역 표시
      </label>
      {!catalog?.configured ? <p className="regulation-status unknown">{error || "규제자료 미연결 · 인증키 설정이 필요합니다."}</p> : <>
        {enabled && <p className="rank-note" role="status">{mapStatus}</p>}
        {target && <div className={`regulation-result ${overlaps.length ? "overlap" : ""}`} aria-live="polite">
          <strong>{target.name} 규제 확인</strong>
          {error ? <p>미확인 · {error}</p> : !check ? <p>선택한 영역의 규제 중첩을 확인하는 중…</p> : <>
            <p>{check.basis}</p>
            <b>{overlaps.length ? `${overlaps.length}개 규제요인 중첩 · 인허가 검토 필요` : check.status === "complete" ? "조회 자료 내 중첩 없음" : "규제요인 미확인"}</b>
            {overlaps.map((item) => <span key={item.id} className="regulation-hit"><i style={{ background: item.color }} />{item.label}</span>)}
            {unknown > 0 && <p>미확인 {unknown}개 항목</p>}
            {check.warning && <p>{check.warning}</p>}
          </>}
        </div>}
      </>}
      {catalog?.configured && enabled && <label className="regulation-opacity">
        <span>지도 채우기 투명도</span>
        <input type="range" min={0} max={100} value={100 - opacity} onChange={(e) => setOpacity(100 - Number(e.target.value))} />
      </label>}
      {catalog && <details className="regulation-layers" open={showLayers || undefined}>
        <summary>규제요인 {catalog.layers.length}종 · 표시 설정</summary>
        {catalog.layers.map((layer) => <label key={layer.id}>
          <input type="checkbox" disabled={!enabled} checked={!hidden.includes(layer.id)} onChange={() => setHidden((old) => old.includes(layer.id) ? old.filter((id) => id !== layer.id) : [...old, layer.id])} />
          <i style={{ background: layer.color }} />{layer.label}
        </label>)}
      </details>}
      <p className="rank-note">{catalog?.notice || "규제자료를 확인하지 못한 상태입니다."}</p>
      <p className="rank-note">표시 설정과 관계없이 선택한 영역의 모든 제공 규제요인을 확인합니다.</p>
      <div className="site-actions">
        <button className="btn" onClick={() => setRetry((old) => old + 1)}>규제 다시 확인</button>
        <a href="https://climate.gg.go.kr/ols/api" target="_blank" rel="noopener noreferrer">자료 출처</a>
      </div>
    </section>
  );
}
