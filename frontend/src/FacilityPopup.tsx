import { num } from "./api";
import OperatingSolar from "./OperatingSolar";
import type { Plant } from "./types";

export type MapFacility = {
  id: string; name: string; latitude: number; longitude: number; capacity_kw: number | null;
  kind: "water" | "land" | "building" | "other"; source: "kwater" | "solartech"; address?: string | null; plant?: Plant;
};

export default function FacilityPopup({ facility, onClose, onReview }: {
  facility: MapFacility; onClose: () => void; onReview?: () => void;
}) {
  const candidate = { name: facility.name.slice(0, 120), latitude: facility.latitude, longitude: facility.longitude,
    site_type: "land", ...(facility.source === "kwater" ? { reference_plant_id: facility.id } : { solartech_asset_id: facility.id }) };
  return <section className="facility-popup" aria-label="발전소 정보">
    <header><div><span>발전소 정보</span><h3>{facility.name}</h3></div><button className="close" aria-label="발전소 정보 닫기" onClick={onClose}>×</button></header>
    <dl className="facility-facts"><div><dt>자료 출처</dt><dd>{facility.source === "kwater" ? "K-water 운영실적" : "등록 설비정보"}</dd></div>
      {facility.address && <div><dt>주소</dt><dd>{facility.address}</dd></div>}
      <div><dt>설치용량</dt><dd>{num(facility.capacity_kw, 1)} kW</dd></div>
      <div><dt>위도 / 경도</dt><dd>{num(facility.latitude, 5)} / {num(facility.longitude, 5)}</dd></div></dl>
    <OperatingSolar payload={JSON.stringify({ candidate })} />
    {onReview && <button className="btn primary block" onClick={onReview}>이 시설로 사업성 검토</button>}
  </section>;
}
