"""Land and building candidates from OpenStreetMap, alongside the water search.

A screening aid only: OSM tags describe what is mapped on the ground, not the
cadastral lot, its owner, zoning, slope or roof structure. Farmland and forest
are left out on purpose (their use for PV is restricted and needs a legal review
this tool does not perform).
"""

import copy
import math
import os

from shapely.geometry import Point, shape

from . import waterbodies as osm

# Individual buildings remain selectable even when they are smaller than an industrial roof.
KINDS = {
    "building": {
        "site_type": "building", "subject": "건축물", "min_area": 30,
        # One request covers roughly a town; dense cities hold many large roofs.
        "max_width": 0.1, "max_height": 0.08, "step": 50,
        "warning": "이 범위에서 OpenStreetMap에 등록된 30 m² 이상 건축물을 찾지 못했습니다.",
        "cache": "building-v3", "limit": 500,
        "attribution": "건축물 외곽 © OpenStreetMap contributors · ODbL (지붕 구조·하중·소유 미확인)",
    },
    "land": {
        "site_type": "land", "subject": "지상 부지", "min_area": 2000,
        "cache": "land", "limit": osm.MAX_RESULTS,
        "max_width": 0.3, "max_height": 0.2, "step": 20,
        "warning": "이 범위에서 2,000 m² 이상인 유휴 부지·주차장·매립지·염전·초지를 찾지 못했습니다. 농지·임야는 검색하지 않습니다.",
        "attribution": "토지이용 경계 © OpenStreetMap contributors · ODbL (지적 경계·지목·용도지역·경사 미확인)",
    },
}
EXCLUDED_BUILDINGS = {"greenhouse", "construction", "ruins", "collapsed", "shed", "hut", "tent", "no"}
BUILDING_LABELS = {
    "industrial": "공장·산업시설", "factory": "공장·산업시설", "manufacture": "공장·산업시설",
    "warehouse": "창고·물류시설", "retail": "상업시설", "commercial": "상업시설", "supermarket": "상업시설",
    "office": "업무시설", "school": "학교", "university": "학교", "college": "학교", "kindergarten": "학교",
    "hospital": "병원", "public": "공공시설", "government": "공공시설", "civic": "공공시설",
    "apartments": "공동주택", "residential": "공동주택", "dormitory": "공동주택",
    "parking": "주차건물", "roof": "캐노피·지붕 구조물", "sports_hall": "체육시설", "stadium": "체육시설",
    "train_station": "교통시설", "transportation": "교통시설", "hangar": "격납고",
}
LAND_LABELS = {"brownfield": "유휴 부지", "greenfield": "개발 예정지", "landfill": "매립지", "quarry": "채석장",
               "salt_pond": "염전", "meadow": "초지", "grassland": "초지"}
EXCLUDED_PARKING = {"underground", "multi-storey", "street_side", "lane", "rooftop"}


def _building_kind(tags):
    value = tags.get("building")
    if not value or value in EXCLUDED_BUILDINGS or tags.get("location") == "underground":
        return None
    return BUILDING_LABELS.get(value, "건축물")


def _land_kind(tags):
    if tags.get("amenity") == "parking":
        return None if tags.get("parking") in EXCLUDED_PARKING or tags.get("building") else "주차장"
    return LAND_LABELS.get(tags.get("landuse")) or LAND_LABELS.get(tags.get("natural"))


def _perimeter_floor(area):
    """No shape of this area has a shorter outline than the circle; lets Overpass drop small ways."""
    return math.floor(2 * math.sqrt(math.pi * area))


def _building_query(west, south, east, north):
    box = f"{south},{west},{north},{east}"
    floor = _perimeter_floor(KINDS["building"]["min_area"])
    return (f"[out:json][timeout:55];("
            f'way["building"]({box})(if:length()>{floor});relation["building"]({box});'
            f");out geom;")


def _land_query(west, south, east, north):
    box = f"{south},{west},{north},{east}"
    floor = _perimeter_floor(KINDS["land"]["min_area"])
    landuse = "^(" + "|".join(k for k in LAND_LABELS if k != "grassland") + ")$"
    return (f"[out:json][timeout:55];("
            f'way["landuse"~"{landuse}"]({box})(if:length()>{floor});relation["landuse"~"{landuse}"]({box});'
            f'way["natural"="grassland"]({box})(if:length()>{floor});relation["natural"="grassland"]({box});'
            f'way["amenity"="parking"]({box})(if:length()>{floor});relation["amenity"="parking"]({box});'
            f");out geom;")


_QUERIES = {"building": (_building_query, _building_kind), "land": (_land_query, _land_kind)}


def find_sites(kind, west, south, east, north):
    """Mapped buildings or open land large enough for a first PV review, biggest first."""
    if kind not in KINDS:
        raise ValueError("검색 종류는 land 또는 building 입니다.")
    if os.getenv("WATER_PROVIDER", "overpass").lower() == "off":
        raise PermissionError("후보지 자료 검색이 꺼져 있습니다 (WATER_PROVIDER=off).")
    spec = KINDS[kind]
    osm._validate_bbox(west, south, east, north, spec["max_width"], spec["max_height"])
    query, classify = _QUERIES[kind]
    key = osm._snap(west, south, east, north, spec["step"])
    # A cached roof click must not wait behind a different viewport's network
    # search. Disk files are written with atomic replace by the OSM cache.
    cached = osm._read_disk(key, spec["cache"])
    if cached is None:
        with osm._lock:
            cached = osm._rows_for(key, spec["cache"], query,
                                   lambda payload: osm._parse(payload, classify, spec["min_area"]),
                                   spec["subject"])
    rows = [row for row in cached if osm._intersects(row, west, south, east, north)]
    return copy.deepcopy({
        "kind": kind, "site_type": spec["site_type"],
        "results": rows[:spec["limit"]], "total": len(rows), "attribution": spec["attribution"],
        "warning": None if rows else spec["warning"],
    })


def building_at(latitude, longitude):
    """Identify the actual footprint covering a map click, including boundary points.

    Nearby roofs are never substituted for an empty point or an inner courtyard.
    """
    if not (math.isfinite(latitude) and math.isfinite(longitude)
            and 33 <= latitude <= 39 and 124 <= longitude <= 132):
        raise ValueError("국내 위치의 건축물만 선택할 수 있습니다.")
    pad = .001
    result = find_sites("building", longitude - pad, latitude - pad, longitude + pad, latitude + pad)
    point = Point(longitude, latitude)
    matches = [row for row in result["results"] if shape(row["geometry"]).covers(point)]
    selected = min(matches, key=lambda row: row["area_m2"]) if matches else None
    return {"building": selected, "attribution": result["attribution"],
            "warning": None if selected else "클릭한 위치에 등록된 건축물 경계가 없습니다. 파란 건축물 경계를 선택하거나 다른 건물을 클릭하세요."}
