"""Gyeonggi Climate Platform's published solar restriction vector layers.

All requests and API credentials stay on the server. Missing, truncated or
failed responses are never treated as evidence that a site is unrestricted.
"""

import copy
import math
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import httpx
from shapely.geometry import Point, box, mapping, shape

from .waterbodies import _validate_bbox

URL = "https://climate.gg.go.kr/ols/api/geoserver/wfs"
SOURCE = "경기기후플랫폼 · 태양광 규제지역 (경기도 제공 범위)"
# Official catalog: https://climate.gg.go.kr/oms/public/openlab/api/layers
# rst_slope_15_ovr is a raster, so it cannot supply vector intersection checks.
LAYERS = [
    ("drinking_water_protection_area", "상수원보호구역", "#ef4444"),
    ("riparian_zone", "수변구역", "#f97316"),
    ("wetland_protection_area", "습지보호구역", "#14b8a6"),
    ("eco1_mgmt_area", "생태자연도 1등급·별도관리지역", "#16a34a"),
    ("national_park", "국립공원", "#15803d"),
    ("provincial_park", "도립공원", "#65a30d"),
    ("county_park", "군립공원", "#84cc16"),
    ("wildlife_protection_area", "야생동식물보호구역", "#059669"),
    ("forest_genetic_resource_protection_area", "산림유전자원보호구역", "#047857"),
    ("watershed_conservation_area", "수원함양보호구역", "#0284c7"),
    ("disaster_prevention_protection_area", "재해방지보호구역", "#e11d48"),
    ("ldsld_grd1", "산사태 1등급", "#b45309"),
    ("landscape", "경관보호구역", "#a855f7"),
    ("national_cultural_property", "국가지정문화재", "#9333ea"),
    ("local_cultural_property", "시도지정문화재", "#c026d3"),
    ("national_registered_property", "국가등록문화재", "#db2777"),
    ("national_cultural_property_zone", "문화재보호구역", "#7c3aed"),
]
_cache = OrderedDict()
_lock = threading.Lock()
LIMIT = 1000


def catalog():
    return {
        "configured": bool(os.getenv("GG_CLIMATE_API_KEY", "").strip()),
        "source": SOURCE,
        "source_url": "https://climate.gg.go.kr/ols/api",
        "layers": [{"id": key, "label": label, "color": color} for key, label, color in LAYERS],
        "notice": "경기도 제공 자료 기준입니다. 경기도 외 지역·미제공 규제·지자체 이격거리 조례·경사도는 별도 확인이 필요합니다. 중첩은 인허가 검토 대상이며 설치 불가 판정이 아닙니다.",
    }


def _fetch(layer, bounds):
    key = os.getenv("GG_CLIMATE_API_KEY", "").strip()
    cache_key = (key, layer, bounds)
    with _lock:
        cached = _cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < 3600:
            return copy.deepcopy(cached[1])
    west, south, east, north = bounds
    params = {
        "apiKey": key, "service": "WFS", "version": "1.1.0", "request": "GetFeature",
        "typeName": f"spggcee:{layer}", "outputFormat": "application/json",
        "srsName": "EPSG:4326",
        # WFS 1.1.0 / EPSG:4326 uses latitude, longitude axis order in BBOX.
        "bbox": f"{south},{west},{north},{east},EPSG:4326",
    }
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as client:
            response = client.get(URL, params=params)
            response.raise_for_status()
            payload = response.json()
        if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            raise ValueError("Invalid FeatureCollection")
        features = []
        for feature in payload["features"]:
            geom = shape(feature["geometry"])
            if geom.is_empty or not geom.is_valid or geom.geom_type not in ("Polygon", "MultiPolygon"):
                raise ValueError("Invalid restriction geometry")
            if not all(math.isfinite(v) for v in geom.bounds) or not (-180 <= geom.bounds[0] <= geom.bounds[2] <= 180 and -90 <= geom.bounds[1] <= geom.bounds[3] <= 90):
                raise ValueError("Unexpected coordinate system")
            features.append({"type": "Feature", "geometry": mapping(geom),
                             "properties": {"layer_id": layer}})
        # A full page may have omitted further features; never certify completeness.
        complete = len(features) < LIMIT
        total = payload.get("totalFeatures", payload.get("numberMatched"))
        if total is not None and str(total).isdigit():
            complete = int(total) == len(features)
        result = {"id": layer, "complete": complete, "features": features,
                  "error": None if complete else "자료가 많아 일부만 조회됐습니다. 지도를 확대해 다시 확인하세요."}
        if complete:
            with _lock:
                _cache[cache_key] = (time.monotonic(), result)
                while len(_cache) > 128:
                    _cache.popitem(last=False)
        return copy.deepcopy(result)
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
        # httpx exception strings can include the secret query-string API key.
        return {"id": layer, "complete": False, "features": [],
                "error": "공식 규제자료를 조회하지 못했습니다. 인증키와 제공기관 상태를 확인하세요."}


def search(west, south, east, north):
    _validate_bbox(west, south, east, north, .3, .2)
    info = catalog()
    if not info["configured"]:
        return {**info, "status": "unavailable", "results": [], "warning": "규제자료 미연결 · 경기기후플랫폼 인증키 설정이 필요합니다."}
    bounds = (west, south, east, north)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda layer: _fetch(layer[0], bounds), LAYERS))
    complete = all(row["complete"] for row in results)
    return {**info, "status": "complete" if complete else "partial", "results": results,
            "warning": None if complete else "일부 규제자료가 미확인입니다. 미확인 항목을 규제 없음으로 판단할 수 없습니다."}


def check(candidate):
    geometry = candidate.get("geometry")
    target = shape(geometry) if geometry else Point(candidate["longitude"], candidate["latitude"])
    if target.is_empty or not target.is_valid:
        raise ValueError("확인할 후보지 경계가 올바르지 않습니다.")
    west, south, east, north = target.bounds
    # Broad envelope only: it excludes obviously out-of-scope requests without
    # claiming an administrative boundary or nationwide coverage.
    if not target.intersects(box(126.3, 36.85, 127.9, 38.35)):
        return {**catalog(), "status": "outside", "items": [], "warning": "경기도 자료 제공 범위 밖입니다. 해당 지자체의 규제자료를 확인하세요."}
    pad = .00001
    data = search(west - pad, south - pad, east + pad, north + pad)
    lookup = {row["id"]: row for row in data["results"]}
    items = []
    for layer, label, color in LAYERS:
        row = lookup.get(layer)
        hit = bool(row and any(target.intersects(shape(f["geometry"])) for f in row["features"]))
        items.append({"id": layer, "label": label, "color": color,
                      "status": "overlap" if hit else "clear" if row and row["complete"] else "unknown"})
    return {k: v for k, v in data.items() if k != "results"} | {
        "items": items, "basis": "후보지 전체 경계" if geometry else "선택 좌표 (부지 전체 경계 미지정)"}
