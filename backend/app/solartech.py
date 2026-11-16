"""Read-only XLSX ingestion and explicit mapping into the review workflow.

Workbook cells are data, never executable instructions. Generation filenames
are references only; this importer does not create observations or train models.
"""
import hashlib
import json
import math
import os
import re
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

from openpyxl import load_workbook
from pydantic import Field

from .schemas import CandidateCreate, DesignCreate, SiteType, StrictModel, defaults

DATA_PATH = Path(os.getenv("SOLARTECH_DATA_PATH", Path(__file__).resolve().parents[1] / "data/solartech/registry.json"))
FIELDS = {
    "통합 발전소명": "name", "발전소 ID": "source_id", "발전량 유무": "generation_mark",
    "원본 발전소명": "original_name", "발전량 파일명": "generation_file", "호기 ID": "unit_id",
    "발전소 주소": "address", "위도": "latitude", "경도": "longitude", "설치장소 유형": "site_type_raw",
    "모듈 방향": "azimuth_raw", "설치각 (˚)": "tilt_raw", "입사각 (˚)": "incidence_angle_raw",
    "설치 유형": "installation_type", "설비 면적": "area_raw", "전체 설치 용량 (kW)": "capacity_kw",
    "모듈 출력용량 (W)": "module_power_raw", "모듈 수": "module_count", "모듈 용량 계산값 (kW)": "source_module_capacity_kw",
    "차이값 (kW)": "source_capacity_difference_kw", "모듈 제조사": "module_manufacturer", "모듈 모델": "module_model",
    "인버터 용량 (kW)": "inverter_capacity_raw", "인버터 수량": "inverter_count",
    "인버터 제조사": "inverter_manufacturer", "인버터 모델": "inverter_model",
    "증설 및 교체 이력": "replacement_history", "발전량 시작일": "generation_start", "발전량 종료일": "generation_end",
    "발전량 기간": "generation_period", "인근 관측소 번호": "station_id", "관측소명": "station_name",
    "데이터 출처": "provider", "비고": "notes",
}


def clean(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, str):
        return value.strip() or None
    return value


def numeric(value):
    # Reject ranges, mixed-module strings and units rather than guessing.
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def angle(value):
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*[˚°](?:\s*\(지면경사\s*:\s*\d+(?:\.\d+)?[˚°]\))?\s*", value)
        if match:
            value = match[1]
    result = numeric(value)
    return result if result is not None and 0 <= result <= 90 else None


def read_workbook(path):
    path = Path(path)
    workbook = load_workbook(path, read_only=True, data_only=True)
    assets = []
    try:
        for sheet in workbook:
            rows = sheet.iter_rows(values_only=True)
            headers = [clean(v) for v in next(rows, ())]
            if "통합 발전소명" not in headers:
                continue
            missing = set(FIELDS) - set(headers)
            if missing:
                raise ValueError(f"필수 열이 없습니다: {', '.join(sorted(missing))}")
            for row_number, row in enumerate(rows, 2):
                raw = {header: clean(value) for header, value in zip(headers, row) if header in FIELDS}
                if not raw.get("통합 발전소명"):
                    continue
                asset = {target: raw.get(source) for source, target in FIELDS.items()}
                identity = json.dumps([sheet.title, asset["source_id"] or asset["name"], asset["unit_id"], asset["address"]], ensure_ascii=False)
                asset.update(id="solartech-" + hashlib.sha256(identity.encode()).hexdigest()[:20],
                             source_sheet=sheet.title, source_row=row_number, raw=raw)
                for key in ("capacity_kw", "module_count", "inverter_count", "latitude", "longitude"):
                    asset[key] = numeric(asset[key])
                asset["module_power_w"] = numeric(asset["module_power_raw"])
                asset["tilt_deg"] = angle(asset["tilt_raw"])
                lat, lon = asset["latitude"], asset["longitude"]
                asset["has_coordinates"] = lat is not None and lon is not None and -89 <= lat <= 89 and -180 <= lon <= 180
                power, count = asset["module_power_w"], asset["module_count"]
                calculated = power * count / 1000 if power and count and power > 0 and count > 0 else None
                asset["calculated_module_capacity_kw"] = calculated
                capacity = asset["capacity_kw"]
                difference = capacity - calculated if capacity is not None and calculated is not None else None
                asset["capacity_difference_kw"] = round(difference, 6) if difference is not None else None
                # Differences greater than 1 W exceed normal floating-point noise.
                asset["capacity_mismatch"] = difference is not None and abs(difference) > .001
                asset["generation_file_referenced"] = bool(asset["generation_file"])
                issues = []
                if not asset["has_coordinates"]:
                    issues.append("좌표 미입력 또는 범위 오류")
                if capacity is None or capacity <= 0:
                    issues.append("설비용량 미입력 또는 범위 오류")
                if asset["capacity_mismatch"]:
                    issues.append("전체 용량과 모듈 출력×수량 불일치")
                if asset["tilt_deg"] is None:
                    issues.append("단일 설치각 확인 필요")
                if not asset["site_type_raw"]:
                    issues.append("설치장소 유형 미입력")
                if power is None or power <= 0:
                    issues.append("혼합 모듈 또는 출력 확인 필요")
                asset["issues"] = issues
                assets.append(asset)
    finally:
        workbook.close()
    if not assets:
        raise ValueError("발전소 정보가 있는 시트를 찾지 못했습니다.")
    if len({a["id"] for a in assets}) != len(assets):
        raise ValueError("동일 발전소·호기·주소가 중복되어 구분할 수 없습니다.")
    coordinates = Counter((a["latitude"], a["longitude"]) for a in assets if a["has_coordinates"])
    for asset in assets:
        if asset["has_coordinates"] and coordinates[(asset["latitude"], asset["longitude"])] > 1:
            asset["issues"].append("다른 발전소와 좌표 중복 · 위치 확인 필요")
    return {"source_file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "imported_at": datetime.now(timezone.utc).isoformat(), "assets": assets,
            "summary": {"plants": len(assets), "with_coordinates": sum(a["has_coordinates"] for a in assets),
                        "generation_references": sum(a["generation_file_referenced"] for a in assets),
                        "capacity_mismatches": sum(a["capacity_mismatch"] for a in assets)},
            "generation_note": "발전량 파일명은 참조 정보입니다. 실제 발전량 시계열은 이 파일에 없어 학습·실적에 추가하지 않습니다."}


def load_registry():
    if not DATA_PATH.exists():
        return {"source_file": None, "assets": [], "summary": {"plants": 0, "with_coordinates": 0, "generation_references": 0, "capacity_mismatches": 0}}
    result = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    from . import generation
    catalog = generation.catalog(DATA_PATH.parent)
    if catalog:
        result["generation_catalog"] = catalog
        for asset in result["assets"]:
            asset["generation_series_ids"] = [series["id"] for series in catalog["series"] if asset["id"] in series["asset_ids"]]
        result["generation_note"] = "엑셀은 설비 제원, ZIP의 CSV는 발전실적입니다. 아래 저장 실적에서 연결된 호기·기간·단위 가정을 확인할 수 있습니다."
    return result


class AssetImport(StrictModel):
    site_type: SiteType  # Never infer ground/roof/water from a name.
    latitude: float = Field(ge=-89, le=89)
    longitude: float = Field(ge=-180, le=180)
    capacity_kw: float = Field(gt=0, le=400000)
    module_power_w: float = Field(ge=1, le=2000)
    tilt: float = Field(ge=0, le=90)
    azimuth: float = Field(ge=90, le=270)


def review_inputs(asset, payload, source_file):
    """Use confirmed inputs; preserve source metadata and label every fallback."""
    source = f"{source_file} · {asset['source_sheet']}!행 {asset['source_row']} · {asset.get('provider') or '출처 미입력'}"
    candidate = CandidateCreate(name=asset["name"][:120], latitude=payload.latitude, longitude=payload.longitude,
                                site_type=payload.site_type, source=(source + " · 설비 제원 기반, 경계 없음. 인버터는 기본 산정모델 사용.")[:300]).model_dump()
    values = defaults(payload.site_type)
    eq = values["equipment"]
    eq.update(module_preset="custom", module_model=(asset.get("module_model") or f"{asset['name']} 모듈 (모델 미상)")[:120],
              module_manufacturer=str(asset.get("module_manufacturer") or "원본 미입력")[:120],
              module_power_w=payload.module_power_w, capacity_mode="capacity", target_capacity_kw=payload.capacity_kw,
              tilt_mode="manual", tilt=payload.tilt, azimuth=payload.azimuth, energy_basis="physics",
              module_price=payload.module_power_w * (500 if payload.site_type == "floating" else 480),
              module_source=(source + " · 출력·설치각은 확인 입력. 치수·전기특성·손실·인버터 효율은 기본 가정, 단가는 가이드라인 환산.")[:500])
    # For roofs, the engine uses roof geometry for flush mount. These confirmed
    # values also populate the roof inputs so later mount changes stay traceable.
    if payload.site_type == "building":
        candidate.update(roof_tilt_deg=payload.tilt, roof_azimuth_deg=payload.azimuth)
    design = DesignCreate(name="엑셀 설비 기준안", candidate_id="pending", **values).model_dump()
    return candidate, design
