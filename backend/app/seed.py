"""Starter project built only from real sources (no fictional sites or weather).

* Reservoir boundaries: cached OpenStreetMap water bodies (ODbL), the same
  features the map search returns.
* Back-test candidate: 아산정수장 2차발전설비 from the imported K-water records,
  reproduced by capacity so its held-out predictions can be compared with actuals.
"""

import glob
import json
import os

from . import kwater
from .schemas import CandidateCreate, DesignCreate
from .waterbodies import ATTRIBUTION, _cache_dir

RESERVOIRS = ["예당저수지", "탑정호"]


def _cached_water(name):
    for path in sorted(glob.glob(os.path.join(_cache_dir(), "*.json"))):
        with open(path, encoding="utf-8") as handle:
            for row in json.load(handle):
                if row.get("name") == name:
                    return row
    return None


def seed_candidates():
    """(candidate payload, [design payloads]) pairs for the available sources."""
    result = []
    for name in RESERVOIRS:
        water = _cached_water(name)
        if not water:
            continue
        candidate = CandidateCreate(
            name=f"{name} ({water['kind']} · OSM 수면 경계)", latitude=water["latitude"], longitude=water["longitude"],
            geometry=water["geometry"], site_type="floating",
            source=f"{ATTRIBUTION} · {water['id']} · 면적 {water['area_m2'] / 10000:,.0f} ha").model_dump()
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
    return result
