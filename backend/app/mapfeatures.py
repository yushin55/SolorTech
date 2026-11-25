"""Selectable map objects, independent of PV candidate screening.

Buildings, land-use polygons and water are loaded together. Size, legal status
and PV suitability do not decide whether a mapped object can be clicked.
"""

import copy
import math
import os

from shapely.geometry import Point, shape

from . import sitefinder, waterbodies as osm

CACHE = "map-features-v2"
ATTRIBUTION = "건축물·토지이용·수면 경계 © OpenStreetMap contributors · ODbL"
ORDER = {"building": 0, "water": 1, "land": 2}
LAND_LABELS = {
    **sitefinder.LAND_LABELS, "farmland": "농지", "farmyard": "농업시설 부지", "orchard": "과수원",
    "vineyard": "포도밭", "forest": "산림", "wood": "산림", "scrub": "관목지", "heath": "황무지",
    "residential": "주거 부지", "industrial": "산업 부지", "commercial": "상업 부지",
    "retail": "상업 부지", "construction": "공사 부지", "recreation_ground": "체육·휴양 부지",
    "cemetery": "묘지", "railway": "철도 부지", "military": "군사 부지", "garages": "차고 부지",
    "sand": "모래 지대", "beach": "해변", "bare_rock": "암반", "scree": "돌밭", "wetland": "습지",
    "park": "공원", "garden": "정원", "pitch": "운동장", "sports_centre": "체육시설 부지",
    "nature_reserve": "자연보호 구역", "golf_course": "골프장",
}
NATURAL = "water|wood|grassland|scrub|heath|wetland|sand|beach|bare_rock|scree|shingle|rock"
LEISURE = "park|garden|pitch|sports_centre|nature_reserve|golf_course"


def _water(tags):
    if tags.get("natural") != "water" and tags.get("landuse") != "reservoir":
        return None
    return osm._water_kind(tags) or "하천·수로"


def _building(tags):
    value = tags.get("building")
    if not value or value == "no" or tags.get("location") == "underground":
        return None
    return sitefinder.BUILDING_LABELS.get(value, "건축물")


def _land(tags):
    if _building(tags) or _water(tags) or tags.get("area") == "no":
        return None
    if tags.get("amenity") == "parking":
        return "주차장" if tags.get("parking") not in sitefinder.EXCLUDED_PARKING else None
    value = tags.get("landuse") or tags.get("natural") or tags.get("leisure")
    return LAND_LABELS.get(value, "지상 부지") if value else None


def _parse(payload):
    if isinstance(payload, dict) and payload.get("remark"):
        raise ValueError("지도 자료 응답이 완전하지 않습니다.")
    rows = []
    for kind, classify in (("building", _building), ("water", _water), ("land", _land)):
        for row in osm._parse(payload, classify, 1, preserve_small_holes=True):
            row["feature_type"] = kind
            rows.append(row)
    return rows


def _query(west, south, east, north):
    box = f"{south},{west},{north},{east}"
    filters = ['["building"]', '["landuse"]', f'["natural"~"^({NATURAL})$"]',
               '["amenity"="parking"]', f'["leisure"~"^({LEISURE})$"]']
    # is_in / pivot also brings back a large land/water polygon enclosing the
    # view even when its outline's vertices lie beyond the rectangle.
    points = [(south, west), (south, east), (north, west), (north, east), ((south + north) / 2, (west + east) / 2)]
    covered = "(" + "".join(f"is_in({lat},{lon});" for lat, lon in points) + ")->.covered;"
    queries = "".join(f"{element}{tag}({box});{element}(pivot.covered){tag};"
                      for tag in filters for element in ("way", "relation"))
    return f"[out:json][timeout:55];{covered}({queries});out geom;"


def _load(bounds):
    if os.getenv("WATER_PROVIDER", "overpass").lower() == "off":
        raise PermissionError("지도 경계 자료 연결이 꺼져 있습니다 (WATER_PROVIDER=off).")
    key = osm._snap(*bounds, step=100)
    rows = osm._read_disk(key, CACHE)
    if rows is None:
        cells = [(x / 100, y / 100, (x + 1) / 100, (y + 1) / 100)
                 for x in range(round(key[0] * 100), round(key[2] * 100))
                 for y in range(round(key[1] * 100), round(key[3] * 100))]
        cached_cells = [osm._read_disk(cell, CACHE) for cell in cells]
        if cells and all(cell is not None for cell in cached_cells):
            unique = {(row["feature_type"], row["id"]): row for cell in cached_cells for row in cell}
            rows = list(unique.values())
        else:
            with osm._lock:
                rows = osm._rows_for(key, CACHE, _query, _parse, "지도 경계")
            # Save complete, uncut geometries for each covered cell. Adjacent
            # pans and point clicks reuse them without another area query.
            for cell in cells:
                osm._write_disk(cell, [row for row in rows if osm._intersects(row, *cell)], CACHE)
    return rows


def viewport(west, south, east, north):
    osm._validate_bbox(west, south, east, north, .08, .06)
    rows = [row for row in _load((west, south, east, north)) if osm._intersects(row, west, south, east, north)]
    return copy.deepcopy({"results": rows, "total": len(rows), "attribution": ATTRIBUTION,
                          "warning": None if rows else "이 지도 범위에 등록된 경계 자료가 없습니다."})


def identify(latitude, longitude):
    if not all(math.isfinite(v) for v in (latitude, longitude)) or not (33 <= latitude <= 39 and 124 <= longitude <= 132):
        raise ValueError("국내 위치의 지도 객체만 선택할 수 있습니다.")
    pad = .0004
    rows = _load((longitude - pad, latitude - pad, longitude + pad, latitude + pad))
    point = Point(longitude, latitude)
    matches = [row for row in rows if shape(row["geometry"]).covers(point)]
    matches.sort(key=lambda row: (ORDER[row["feature_type"]], row["area_m2"], row["id"]))
    return copy.deepcopy({"feature": matches[0] if matches else None, "attribution": ATTRIBUTION,
                          "warning": None if matches else "이 위치에 등록된 건축물·지상·수상 경계가 없습니다. 표시된 경계를 선택해 주세요."})
