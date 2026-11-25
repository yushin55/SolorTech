"""Existing installations and recorded energy only; never design predictions."""
import calendar
import math

from shapely.geometry import Point, shape

from . import generation, kwater, solartech
from .solar_estimate import _distance


def _years(records, resolution):
    groups = {}
    for record in records:
        value = record.get("value")
        # Zero production is a real observation. Flagged/ambiguous readings are
        # excluded, without replacing them or extrapolating missing periods.
        if value is None or not math.isfinite(value) or value < 0 or record.get("flags"):
            continue
        period = record["period"]
        year = int(period[:4])
        group = groups.setdefault(year, {})
        group[period] = value
    result = []
    for year, periods in sorted(groups.items(), reverse=True):
        start, end = min(periods), max(periods)
        expected = 12 if resolution == "monthly" else 366 if calendar.isleap(year) else 365
        result.append({"year": year, "recorded_kwh": sum(periods.values()), "observed_periods": len(periods),
                       "monthly_kwh": [sum(value for period, value in periods.items() if int(period[5:7]) == month)
                                       if any(int(period[5:7]) == month for period in periods) else None for month in range(1, 13)],
                       "expected_periods": expected, "resolution": resolution, "complete": len(periods) == expected,
                       "start": start, "end": end})
    return result


def status(candidate):
    linked_plant = candidate.get("reference_plant_id")
    linked_asset = candidate.get("solartech_asset_id")
    boundary = shape(candidate["geometry"]) if candidate.get("geometry") else None
    scope = "linked" if linked_plant or linked_asset else "boundary" if boundary else "nearby"

    def matches(row, source):
        if scope == "linked":
            return row["id"] == (linked_plant if source == "kwater" else linked_asset)
        if row.get("latitude") is None or row.get("longitude") is None:
            return False
        if boundary:
            return boundary.covers(Point(row["longitude"], row["latitude"]))
        return _distance(candidate["latitude"], candidate["longitude"], row) <= 10

    facilities = []
    plants = [row for row in kwater.load_registry() if matches(row, "kwater")]
    daily = kwater.load_daily() if plants else None
    for plant in plants:
        records = daily[daily.plant_id == plant["id"]].drop_duplicates("date", keep="last") if not daily.empty else daily
        values = [{"period": r.date.date().isoformat(), "value": float(r.kwh) if r.kwh == r.kwh else None,
                   "flags": [] if r.flag in ("ok", "zero") else [r.flag]} for r in records.itertuples()]
        facilities.append({"id": plant["id"], "name": plant["name"], "source": "K-water 운영실적",
                           "source_group": "kwater", "capacity_kw": plant.get("capacity_kw"),
                           "series": [{"id": plant["id"], "label": "계량 발전량" if plant["data_kind"] == "generation" else "전력거래량",
                                       "unit_notice": None, "years": _years(values, "daily")}],
                           "location_notice": plant.get("coordinate_basis")})
    registry = solartech.load_registry()
    catalog = registry.get("generation_catalog") or {}
    for asset in registry.get("assets", []):
        if not matches(asset, "solartech"):
            continue
        series = []
        for item in catalog.get("series", []):
            # A series linked to several assets cannot establish a site's actual
            # generation without resolving the ambiguous identity first.
            if item.get("asset_ids") != [asset["id"]]:
                continue
            series.append({"id": item["id"], "label": f"발전실적 · {item.get('unit_id') or '호기 미표기'}",
                           "unit_notice": item.get("unit_basis"),
                           "years": _years(generation.observations(item["id"], folder=solartech.DATA_PATH.parent), item["resolution"])})
        facilities.append({"id": asset["id"], "name": asset["name"], "source": registry.get("source_file") or "설비정보 등록자료",
                           "source_group": "solartech", "capacity_kw": asset.get("capacity_kw"), "series": series,
                           "location_notice": "등록 좌표 기준 · 설비정보에 기록된 기존 시설"})
    return {"scope": scope, "scope_label": {"linked": "선택 후보지에 연결된 기존 시설", "boundary": "선택 경계 안에 등록 좌표가 있는 시설",
                                               "nearby": "선택 위치 반경 10 km의 등록 시설"}[scope],
            "facilities": facilities,
            "notice": "등록 자료에서 확인한 설치 현황과 기록된 실적입니다. 미등록 시설은 포함하지 않으며, 실적은 자료가 있는 기간만 합산합니다. 발전량과 전력거래량, 서로 다른 출처의 시설은 합산하지 않습니다."}
