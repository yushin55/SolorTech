"""Fast, explicitly empirical estimates from imported K-water operating records.

No regional totals are inferred. Twelve calendar months are required per reference
plant; each contributing plant-month must have at least 80% QC-passed days.
"""
import calendar
import math

from . import kwater
from .engine import guideline, siting
from .engine.analysis import _layout, capacity_plan, design_strings
from .schemas import Equipment


def _distance(latitude, longitude, plant):
    lat1, lat2 = map(math.radians, (latitude, plant["latitude"]))
    dlat = lat2 - lat1
    dlon = math.radians(plant["longitude"] - longitude)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(a)))


def reference_plants(latitude, longitude, site_type):
    daily = kwater.load_daily()
    if daily.empty:
        return []
    # Count each date once. Missing/zero/spike days never become normal output.
    valid = daily.drop_duplicates(["plant_id", "date"], keep="last")
    valid = valid[(valid.flag == "ok") & valid.kwh.notna() & (valid.kwh > 0)].copy()
    if valid.empty:
        return []
    valid["year"] = valid.date.dt.year
    valid["month"] = valid.date.dt.month
    monthly = valid.groupby(["plant_id", "year", "month"]).agg(days=("kwh", "count"), kwh=("kwh", "mean")).reset_index()
    monthly = monthly[monthly.apply(lambda r: r.days >= calendar.monthrange(int(r.year), int(r.month))[1] * kwater.MIN_MONTH_COVERAGE, axis=1)]
    rows = []
    for plant in kwater.load_registry():
        capacity = plant.get("capacity_kw", 0)
        if not capacity or capacity <= 0:
            continue
        months = monthly[monthly.plant_id == plant["id"]].groupby("month").kwh.mean()
        if len(months) != 12:
            continue
        specific_yield = sum(float(months[m]) * calendar.monthrange(2025, m)[1] for m in range(1, 13)) / capacity
        if not math.isfinite(specific_yield) or specific_yield <= 0:
            continue
        records = valid[valid.plant_id == plant["id"]]
        rows.append({"id": plant["id"], "name": plant["name"], "type": plant["type"],
                     "data_kind": plant["data_kind"], "capacity_kw": capacity,
                     "distance_km": _distance(latitude, longitude, plant), "specific_yield": specific_yield,
                     "monthly_specific_yield": [float(months[m]) * calendar.monthrange(2025, m)[1] / capacity for m in range(1, 13)],
                     "first_date": records.date.min().date().isoformat(), "last_date": records.date.max().date().isoformat()})
    comparable = [r for r in rows if (r["type"] == "floating") == (site_type == "floating")]
    # Do not transfer a floating-only reference to roofs/land, or vice versa.
    return sorted(comparable, key=lambda row: (row["distance_km"], row["id"]))[:5]


def estimate(candidate, equipment=None):
    rows = reference_plants(candidate["latitude"], candidate["longitude"], candidate["site_type"])
    if not rows:
        return {"status": "unavailable", "references": [],
                "notice": "연중 12개월의 품질 기준을 충족한 등록 발전실적이 부족합니다."}
    weights = [1 / max(10, row["distance_km"]) ** 2 for row in rows]
    specific_yield = sum(row["specific_yield"] * weight for row, weight in zip(rows, weights)) / sum(weights)
    result = {"status": "available", "specific_yield": specific_yield, "references": rows,
              "monthly_specific_yield": [sum(row["monthly_specific_yield"][month] * weight for row, weight in zip(rows, weights)) / sum(weights) for month in range(12)],
              "capacity_dc_kw": None, "annual_kwh": None, "module_count": None,
              "notice": "등록된 발전량·전력거래량의 월별 정상 가동일 평균을 평년 일수로 환산하고, 유사 설치 유형의 인근 시설을 거리 가중 평균한 예비 추정입니다. 지역 전체 통계가 아니며 음영·방향·기상 차이는 반영하지 않습니다."}
    supplied = equipment is not None
    if equipment is None:
        equipment = Equipment(capacity_mode="area", area_use_pct=10 if candidate["site_type"] == "floating" else 65).model_dump()
    result["capacity_basis"] = "저장된 설계 조건" if supplied else f"경계 면적 기준 · 배치 이용률 {equipment['area_use_pct']:g}% · 기본 모듈·이격거리"
    if not candidate.get("geometry") and equipment["capacity_mode"] == "area":
        return result
    resolved, pitch, _ = siting.resolve(candidate, equipment, guideline.site_factors(candidate["latitude"], candidate["longitude"]))
    _, maximum = _layout(candidate, resolved, pitch)
    plan = capacity_plan(resolved, pitch, maximum)
    if plan["requested_modules"] < 1:
        result.update(capacity_dc_kw=0, annual_kwh=0, module_count=0)
        return result
    strings = design_strings(plan, resolved)
    capacity = strings["modules_used"] * resolved["module_power_w"] / 1000
    result.update(capacity_dc_kw=capacity, annual_kwh=capacity * specific_yield, module_count=strings["modules_used"])
    return result


def potential(candidate, equipment=None):
    """Boundary-based installation scenario, independent of existing module count."""
    equipment = dict(equipment) if equipment is not None else Equipment(
        area_use_pct=10 if candidate["site_type"] == "floating" else 65).model_dump()
    # Obtain the empirical resource reference without reusing the saved design's
    # capacity, which is a design choice and is not the site's potential.
    reference_equipment = {**equipment, "capacity_mode": "area"}
    result = estimate({**candidate, "geometry": None}, reference_equipment)
    result.update(capacity_dc_kw=None, annual_kwh=None, module_count=None, usable_area_m2=None,
                  capacity_basis="부지 경계를 선택하면 면적 기반 설치 잠재량을 계산합니다.")
    if not candidate.get("geometry") and equipment.get("capacity_mode") != "site_area":
        return result
    resolved, pitch, _ = siting.resolve(candidate, equipment, guideline.site_factors(candidate["latitude"], candidate["longitude"]))
    if candidate.get("geometry"):
        layout, maximum = _layout(candidate, resolved, pitch)
        coverage = equipment["area_use_pct"]
        modules = math.floor(maximum * coverage / 100)
        result.update(usable_area_m2=layout["usable_area_m2"],
                      capacity_basis=f"경계 내 유효면적 × 배치 이용률 {coverage:g}% · 선택 모듈·이격거리 기준")
    else:
        usable = equipment["site_area_m2"] * (1 - equipment["reserve_pct"] / 100)
        modules = math.floor(usable / (pitch["pitch_m"] * resolved["module_width_m"])) * resolved["array_rows"]
        result.update(usable_area_m2=usable, capacity_basis="입력한 부지 면적에서 여유 면적을 제외한 설치 잠재량")
    capacity = modules * resolved["module_power_w"] / 1000
    result.update(status="available", capacity_dc_kw=capacity, module_count=modules,
                  annual_kwh=capacity * result["specific_yield"] if result.get("specific_yield") is not None else None)
    result["monthly_kwh"] = [capacity * value for value in result.get("monthly_specific_yield", [])]
    return result
