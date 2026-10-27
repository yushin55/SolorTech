"""Standing water bodies (reservoirs, lakes, ponds) from OpenStreetMap via Overpass.

Only the requested map rectangle is sent upstream, and only when the user asks.
Results are mapped features, not surveyed shorelines; water level changes the
real surface area through the year.
"""

import copy
import json
import math
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx
from pyproj import Geod
from shapely.geometry import LineString, MultiPolygon, Polygon, mapping
from shapely.ops import linemerge, polygonize, unary_union

# Public Overpass instances; both are asked at once and the first answer wins,
# because the main instance is often slow under load.
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
USER_AGENT = "Solar-Site-Workspace/1.0 (Korean floating solar feasibility desktop workspace)"
ATTRIBUTION = "수면 경계 © OpenStreetMap contributors · ODbL (실측 수면 아님)"
MAX_WIDTH, MAX_HEIGHT = 0.8, 0.6  # degrees; keeps one request to a few city districts
MIN_AREA_M2 = 10_000  # 1 ha; smaller ponds rarely fit a floating array
MAX_RESULTS = 80
MAX_COORDINATES = 8000  # stays under the candidate schema limit of 10,000
CACHE_TTL = 24 * 60 * 60
DISK_TTL = 30 * 24 * 60 * 60  # mapped shorelines change slowly
# Flowing or artificial channels are not floating-PV surfaces.
EXCLUDED_WATER = {"river", "canal", "stream", "ditch", "drain", "moat", "wastewater", "lock", "stream_pool", "rapids"}
KIND_LABELS = {"reservoir": "저수지", "lake": "호수", "pond": "연못", "basin": "유수지", "lagoon": "석호", "oxbow": "우각호"}

_geod = Geod(ellps="WGS84")
_cache = OrderedDict()
_lock = threading.Lock()
_last_request_at = None


def _validate_bbox(west, south, east, north):
    values = (west, south, east, north)
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
        raise ValueError("지도 범위가 올바르지 않습니다.")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("지도 범위는 서<동, 남<북 순서여야 합니다.")
    if east - west > MAX_WIDTH + 1e-9 or north - south > MAX_HEIGHT + 1e-9:
        raise ValueError("검색 범위가 너무 넓습니다. 지도를 더 확대한 뒤 다시 찾으세요.")


def _query(west, south, east, north):
    box = f"{south},{west},{north},{east}"
    return (f"[out:json][timeout:55];("
            f'way["natural"="water"]({box});relation["natural"="water"]({box});'
            f'way["landuse"="reservoir"]({box});relation["landuse"="reservoir"]({box});'
            f");out geom;")


def _fetch(url, query):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    with httpx.Client(timeout=60.0, follow_redirects=False, headers=headers) as client:
        response = client.post(url, data={"data": query})
        response.raise_for_status()
        return response.json()


def _request(query):
    pool = ThreadPoolExecutor(max_workers=len(OVERPASS_URLS))
    futures = [pool.submit(_fetch, url, query) for url in OVERPASS_URLS]
    try:
        error = None
        for future in as_completed(futures):
            try:
                return future.result()
            except (httpx.HTTPError, ValueError) as exc:
                error = exc
        raise error
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _line(points):
    coords = [(float(p["lon"]), float(p["lat"])) for p in points or []]
    return LineString(coords) if len(coords) >= 2 else None


def _rings(lines):
    lines = [line for line in lines if line is not None]
    if not lines:
        return None
    polygons = list(polygonize(linemerge(lines)))
    return unary_union(polygons) if polygons else None


def _geometry(element):
    if element.get("type") == "way":
        coords = [(float(p["lon"]), float(p["lat"])) for p in element.get("geometry") or []]
        if len(coords) < 4 or coords[0] != coords[-1]:
            return None
        return Polygon(coords)
    if element.get("type") == "relation":
        members = [m for m in element.get("members", []) if m.get("type") == "way"]
        outer = _rings([_line(m.get("geometry")) for m in members if m.get("role") in ("outer", "")])
        if outer is None:
            return None
        inner = _rings([_line(m.get("geometry")) for m in members if m.get("role") == "inner"])
        return outer.difference(inner) if inner is not None else outer
    return None


def _area_m2(polygon):
    return abs(_geod.geometry_area_perimeter(polygon)[0])


def _coordinate_count(polygon):
    return len(polygon.exterior.coords) + sum(len(ring.coords) for ring in polygon.interiors)


def _fit(polygon):
    """Simplify until the shoreline fits the candidate schema; drop tiny islands first."""
    for tolerance in (0.00002, 0.00005, 0.0001, 0.0002, 0.0005):
        shape = polygon.simplify(tolerance, preserve_topology=True)
        if not shape.is_valid:
            shape = shape.buffer(0)
        if shape.geom_type == "MultiPolygon":
            shape = max(shape.geoms, key=lambda g: g.area)
        if shape.geom_type != "Polygon" or shape.is_empty:
            return None
        islands = sorted(shape.interiors, key=lambda r: Polygon(r).area, reverse=True)
        shape = Polygon(shape.exterior, [r for r in islands[:100] if Polygon(r).area > 1e-8])
        if _coordinate_count(shape) <= MAX_COORDINATES and shape.is_valid:
            return shape
    return None


def _parse(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise ValueError("Invalid Overpass response")
    results = []
    for element in payload["elements"]:
        tags = element.get("tags") or {}
        water = tags.get("water", "")
        if water in EXCLUDED_WATER or tags.get("natural") == "coastline":
            continue
        try:
            geometry = _geometry(element)
        except (ValueError, TypeError, KeyError):
            continue
        if geometry is None or geometry.is_empty:
            continue
        if not geometry.is_valid:
            geometry = geometry.buffer(0)
        parts = list(geometry.geoms) if isinstance(geometry, MultiPolygon) else [geometry]
        kind = "저수지" if tags.get("landuse") == "reservoir" else KIND_LABELS.get(water, "수면")
        name = (tags.get("name:ko") or tags.get("name") or "").strip()[:100] or None
        for index, part in enumerate(sorted(parts, key=lambda g: g.area, reverse=True)):
            if part.geom_type != "Polygon":
                continue
            area = _area_m2(part)
            if area < MIN_AREA_M2:
                continue
            minx, miny, maxx, maxy = part.bounds
            if maxx - minx > 1 or maxy - miny > 1:
                continue  # Larger than one candidate may cover.
            shape = _fit(part)
            if shape is None:
                continue
            point = shape.representative_point()
            identifier = f"{element.get('type')}/{element.get('id')}" + (f"-{index}" if index else "")
            results.append({
                "id": identifier,
                "name": name,
                "kind": kind,
                "area_m2": round(area, 1),
                "latitude": round(point.y, 6),
                "longitude": round(point.x, 6),
                "geometry": mapping(shape),
            })
    # The same water body can be tagged as both a way and a relation member.
    seen, unique = set(), []
    for row in sorted(results, key=lambda r: r["area_m2"], reverse=True):
        key = (row["name"], round(row["area_m2"], -2), round(row["latitude"], 3), round(row["longitude"], 3))
        if key not in seen:
            seen.add(key)
            unique.append(row)
    for row in unique:
        row["geometry"] = {"type": "Polygon", "coordinates": [[list(map(float, p)) for p in ring]
                                                              for ring in row["geometry"]["coordinates"]]}
    return unique


def _cache_dir():
    default = Path(__file__).resolve().parent.parent / "data" / "water-cache"
    return Path(os.getenv("WATER_CACHE_DIR", default))


def _snap(west, south, east, north):
    """Widen to a 0.1 degree grid so nearby views share one cached upstream answer."""
    step = 10
    return (math.floor(west * step) / step, math.floor(south * step) / step,
            math.ceil(east * step) / step, math.ceil(north * step) / step)


def _read_disk(key):
    path = _cache_dir() / ("_".join(f"{v:.1f}" for v in key) + ".json")
    try:
        if time.time() - path.stat().st_mtime < DISK_TTL:
            return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    return None


def _write_disk(key, rows):
    directory = _cache_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ("_".join(f"{v:.1f}" for v in key) + ".json")
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        pass  # A read-only data folder only costs a repeat download.


def _rows_for(key):
    global _last_request_at
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        _cache.move_to_end(key)
        return cached[1]
    rows = _read_disk(key)
    if rows is None:
        if _last_request_at is not None:
            delay = 1.0 - (time.monotonic() - _last_request_at)
            if delay > 0:
                time.sleep(delay)
        _last_request_at = time.monotonic()
        try:
            rows = _parse(_request(_query(*key)))
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise ConnectionError("수면 자료 서버(OpenStreetMap)가 응답하지 않습니다. 공용 서버가 혼잡할 수 있으니 잠시 후 다시 시도하세요.") from error
        _write_disk(key, rows)
    _cache[key] = (time.monotonic() + CACHE_TTL, rows)
    while len(_cache) > 128:
        _cache.popitem(last=False)
    return rows


def _intersects(row, west, south, east, north):
    ring = row["geometry"]["coordinates"][0]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return min(xs) <= east and max(xs) >= west and min(ys) <= north and max(ys) >= south


def find_water_bodies(west, south, east, north):
    """Return reservoirs/lakes/ponds of at least 1 ha intersecting the rectangle."""
    if os.getenv("WATER_PROVIDER", "overpass").lower() == "off":
        raise PermissionError("수면 자료 검색이 꺼져 있습니다 (WATER_PROVIDER=off).")
    _validate_bbox(west, south, east, north)
    with _lock:
        rows = [row for row in _rows_for(_snap(west, south, east, north))
                if _intersects(row, west, south, east, north)]
    return copy.deepcopy({
        "results": rows[:MAX_RESULTS],
        "total": len(rows),
        "attribution": ATTRIBUTION,
        "warning": None if rows else "이 범위에서 1 ha 이상의 저수지·호수를 찾지 못했습니다.",
    })
