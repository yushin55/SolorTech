"""Shared demo sizing used by the editor preview and the saved analysis."""
import math

from . import catalog, guideline, siting
from .common import number


def input_count(equipment, pitch):
    mode = equipment.get("capacity_mode")
    power = number(equipment, "module_power_w", minimum=1)
    if mode == "target":
        return math.ceil(number(equipment, "target_capacity_kw", minimum=.001) * 1000 / power)
    if mode == "area_input":
        area = number(equipment, "site_area_m2", minimum=.001)
        reserve = number(equipment, "reserve_pct", default=20, minimum=0, maximum=99.999)
        footprint = pitch["pitch_m"] * number(equipment, "module_width_m", minimum=.05)
        if footprint <= 0:
            raise ValueError("수평 투영 배치 면적이 0입니다. 경사각 또는 이격거리를 조정하세요.")
        return math.floor(area * (1 - reserve / 100) / footprint) * int(equipment.get("array_rows", 1))
    return None


def strings_for(count, equipment):
    if count < 1 or count > 200000:
        raise ValueError("계산 모듈 수는 1~200,000장이어야 합니다. 면적 또는 목표 용량을 조정하세요.")
    if equipment.get("capacity_mode") == "target":
        probe = guideline.string_design(max(1000, count), equipment)
        count = math.ceil(count / probe["series"]) * probe["series"]
        if count > 200000:
            raise ValueError("직렬 단위 조정 후 모듈 수가 200,000장을 초과합니다.")
    return guideline.string_design(count, equipment)


def preview(candidate, equipment):
    factors = guideline.site_factors(candidate["latitude"], candidate["longitude"])
    resolved, pitch, _, _ = siting.resolve(candidate, equipment, factors)
    count = input_count(resolved, pitch)
    if count is None:
        return {"legacy": True, "basis": "기존 수량·지도 경계 입력은 분석 실행 후 표시합니다."}
    strings = strings_for(count, resolved)
    spec = catalog.MODULES.get(resolved.get("module_preset"))
    return {"legacy": False, "minimum_modules": count, "module_count": strings["modules_used"],
            "capacity_kw": strings["modules_used"] * resolved["module_power_w"] / 1000,
            "target_capacity_kw": resolved.get("target_capacity_kw") if resolved["capacity_mode"] == "target" else None,
            "site_area_m2": resolved.get("site_area_m2") if resolved["capacity_mode"] == "area_input" else None,
            "reserve_pct": resolved.get("reserve_pct", 20), "pitch": pitch,
            "module": {"manufacturer": spec["manufacturer"] if spec else resolved.get("module_manufacturer", "미지정 (가이드라인 예시)"),
                       "model": spec["label"] if spec else resolved["module_model"],
                       "power_w": resolved["module_power_w"], "width_m": resolved["module_width_m"],
                       "height_m": resolved["module_height_m"],
                       "source": spec["source"] if spec else resolved.get("module_source", guideline.SOURCE)},
            "basis": "예비 배치: 경사에 따른 수평 투영 길이 + 행간 이격, 여유 면적은 통로·장애물 가정. "
                     "목표 용량은 올림한 최소 수량을 직렬 단위로 올림하고, 면적 기준은 직렬 단위로 내림합니다. "
                     "입력 면적 기반 계산이며 지도 경계 내 실제 배치·구조 검증은 별도입니다.",
            "warnings": strings["warnings"]}
