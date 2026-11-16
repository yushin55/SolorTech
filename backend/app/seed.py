"""Starter project built only from real sources (no fictional sites or weather).

* Reservoir, land and building boundaries: cached OpenStreetMap features (ODbL),
  the same ones the map search returns. Land and buildings are the largest
  features found near each reservoir, unverified beyond what OSM maps.
* Back-test candidate: 아산정수장 2차발전설비 from the imported K-water records,
  reproduced by capacity so its held-out predictions can be compared with actuals.
"""

import glob
import json
import os

from . import kwater
from .schemas import CandidateCreate, DesignCreate, defaults
from .waterbodies import ATTRIBUTION, _cache_dir

# Who manages the water decides whether a project is possible at all; keep it with the site.
RESERVOIRS = {
    "예당저수지": "관리: 한국농어촌공사 예산지사(농업용 저수지, K-water 시설 아님) · 수면 사용 협의·계통·수심 미확인",
    "탑정호": "농업용 저수지(탑정지), 관리 주체는 한국농어촌공사로 추정·공식 확인 필요(K-water 시설 아님) · 수면 사용 협의·계통·수심 미확인",
}
# (search layer, OSM id, reservoir whose surroundings were searched)
SITES = [
    ("building", "way/1341503367", "예당저수지"),
    ("land", "way/1319376402", "예당저수지"),
    ("building", "way/1559875214", "탑정호"),
    ("land", "way/890923013", "탑정호"),
]


def _cached(folder, match):
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        with open(path, encoding="utf-8") as handle:
            for row in json.load(handle):
                if match(row):
                    return row
    return None


def _cached_water(name):
    return _cached(_cache_dir(), lambda row: row.get("name") == name)


def _area(m2):
    return f"{m2:,.0f} m²" if m2 < 10000 else f"{m2 / 10000:,.1f} ha"


def seed_candidates():
    """(candidate payload, [design payloads]) pairs for the available sources."""
    result = []
    for name, note in RESERVOIRS.items():
        water = _cached_water(name)
        if not water:
            continue
        candidate = CandidateCreate(
            name=f"{name} ({water['kind']} · OSM 수면 경계)", latitude=water["latitude"], longitude=water["longitude"],
            geometry=water["geometry"], site_type="floating",
            source=f"{ATTRIBUTION} · {water['id']} · 면적 {water['area_m2'] / 10000:,.0f} ha · {note}"[:300]).model_dump()
        fixed = DesignCreate(name="기본안 · 고정형 1.08 MW", candidate_id="pending").model_dump()
        seasonal = DesignCreate(name="비교안 · 가변형 1.08 MW", candidate_id="pending").model_dump()
        seasonal["equipment"]["structure_type"] = "seasonal"
        result.append((candidate, [fixed, seasonal]))
    plant = kwater.plant("asan-2")
    if plant:
        candidate = CandidateCreate(
            name=f"{plant['name']} (실적 재현 검토)", latitude=plant["latitude"], longitude=plant["longitude"],
            geometry=None, site_type="plant", reference_plant_id=plant["id"],
            source=f"K-water 운영실적 · {plant['source']} · {plant['capacity_kw']:,.1f} kWp · 좌표 {plant['coordinate_basis']}").model_dump()
        design = DesignCreate(name=f"기존 설비 {plant['capacity_kw']:,.0f} kWp 재현", candidate_id="pending").model_dump()
        design["equipment"].update(module_preset="land_480", module_model="육상용 단결정 480 Wp (가이드라인 표 3-9)",
                                   module_power_w=480, module_width_m=1.043, module_height_m=2.275,
                                   module_price=230400, module_count=round(plant["capacity_kw"] * 1000 / 480),
                                   purpose="sale")
        design["costs"].update(float_per_kw=0, mooring_per_kw=0)
        result.append((candidate, [design]))
    for layer, osm_id, near in SITES:
        row = _cached(os.path.join(_cache_dir(), layer), lambda item: item.get("id") == osm_id)
        if not row:
            continue
        roof = layer == "building"
        area = _area(row["area_m2"])
        label = row["name"] or f"{near} 인근 {row['kind']} ({area})"
        candidate = CandidateCreate(
            name=f"{label} · OSM 검색 미검증",
            latitude=row["latitude"], longitude=row["longitude"], geometry=row["geometry"],
            site_type="rooftop" if roof else "land", boundary_setback_m=1.0,
            source=(f"{row['kind']} 경계 © OpenStreetMap contributors · {osm_id} · {area} · {near} 인근 검색 범위의 최대 면적 · "
                    f"{'지붕 구조·하중·소유' if roof else '지목·용도지역·경사·소유'} 미확인")).model_dump()
        values = defaults(candidate["site_type"])
        values["equipment"]["capacity_mode"] = "area"  # sized from the mapped outline
        design = DesignCreate(name="기본안 · 경계 면적 70% 배치", candidate_id="pending", **values).model_dump()
        result.append((candidate, [design]))
    return result
