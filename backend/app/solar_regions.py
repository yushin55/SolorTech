"""Read the public aggregate data displayed by the Gyeonggi Climate Platform."""

import math
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import httpx
from pyproj import Transformer
from shapely.errors import ShapelyError
from shapely.geometry import Point, shape

SOURCE_URL = "https://climate.gg.go.kr/ips/engy/solar-adoption"
BASE_URL = "https://climate.gg.go.kr"
_projection = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
_workers = ThreadPoolExecutor(max_workers=8)
_levels = {"theoretical": "thry", "technical": "tech", "market": "mrkt"}


def _post(path, **kwargs):
    with httpx.Client(timeout=6, follow_redirects=False) as client:
        response = client.post(BASE_URL + path, **kwargs)
        response.raise_for_status()
        return response.json()


def _text(value):
    return value.strip()[:160] if isinstance(value, str) and value.strip() else None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def _row(value):
    return value if isinstance(value, dict) else {}


def _code(value, length=8):
    value = _text(value)
    return value if value and len(value) == length and value.isascii() and value.isdigit() else None


@lru_cache(maxsize=2048)
def _position(latitude, longitude, _hour):
    x, y = _projection.transform(longitude, latitude)
    payload = _post("/gcs/cmm/selectUserPosition.do", data={"st_x": x, "st_y": y})
    if not isinstance(payload, dict) or "list" not in payload:
        raise ValueError("Invalid region response")
    return _row(payload["list"])


@lru_cache(maxsize=64)
def _boundaries(path, _day):
    response = httpx.get(f"{BASE_URL}/ips/data/chart/{path}", timeout=6, follow_redirects=False)
    response.raise_for_status()
    payload = _row(response.json())
    features = payload.get("features")
    if payload.get("type") != "FeatureCollection" or not isinstance(features, list) or not features:
        raise ValueError("Invalid region boundaries")
    rows = []
    for feature in features:
        row = _row(feature)
        fields = _row(row.get("properties"))
        code = _code(fields.get("cd"), 4 if path.endswith("/sigun.json") else 8)
        name = _text(fields.get("nm"))
        geometry = shape(_row(row.get("geometry"))) if isinstance(row.get("geometry"), dict) else None
        if geometry is None:
            raise ValueError("Missing region boundary geometry")
        if not (code and name and geometry.is_valid and not geometry.is_empty
                and geometry.geom_type in ("Polygon", "MultiPolygon")):
            raise ValueError("Invalid region boundary feature")
        west, south, east, north = geometry.bounds
        if not (124 <= west <= east <= 132 and 33 <= south <= north <= 39):
            raise ValueError("Unexpected region boundary coordinates")
        rows.append((code, name, geometry))
    if path.endswith("/sigun.json") and len(rows) != 31:
        raise ValueError("Incomplete Gyeonggi boundaries")
    return rows


def _covers(rows, point):
    return next((row for row in rows if row[2].covers(point)), None)


def _boundary_position(latitude, longitude, day, position):
    point = Point(longitude, latitude)
    counties = _boundaries("hjd/sigun.json", day)
    county = _covers(counties, point)
    if county is None:
        # The published chart outlines are simplified. Treat points near their
        # edges as unresolved if the primary lookup also has no match.
        return ("unmatched" if any(row[2].dwithin(point, .005) for row in counties) else "outside"), {}

    code, name, _geometry = county
    result = {"sigun_nm": name, "sgg_nm": name}
    if not _code(position.get("hjd2506_cd")):
        try:
            admin = _covers(_boundaries(f"hjd/20250630/emd-{code}.json", day), point)
            if admin:
                result.update(hjd2506_cd=admin[0], hjd2506_nm=admin[1])
        except (httpx.HTTPError, ValueError, ShapelyError, TypeError):
            pass
    if not _legal_code(position):
        try:
            area = _covers(_boundaries("bjd/sigun.json", day), point)
            legal = _covers(_boundaries(f"bjd/20260622/emd-{area[0]}.json", day), point) if area else None
            if legal:
                result.update(cur_stdg_cd=legal[0], cur_stdg_nm=legal[1])
        except (httpx.HTTPError, ValueError, ShapelyError, TypeError):
            pass
    return "unmatched", result


def _legal_code(position):
    return _code(position.get("cur_stdg_cd")) or _code(position.get("stdg_cd"))


def _sizes(row, ground, roof):
    return {"ground_mwh": _number(row.get(ground)), "roof_mwh": _number(row.get(roof))}


@lru_cache(maxsize=1024)
def _potential(code, _hour):
    fields = [f"{prefix}_{surface}_genqy" for prefix in _levels.values() for surface in ("ground", "rooftop")]
    rows = _post("/ips/solar/potential/data", json={"areas": [code], "codes": fields, "areanames": []})
    if not isinstance(rows, list):
        raise ValueError("Invalid solar potential response")
    row = next((item for item in rows if _text(_row(item).get("area")) == code), {})
    values = {key: _sizes(row, f"{prefix}_ground_genqy", f"{prefix}_rooftop_genqy")
              for key, prefix in _levels.items()}
    return values if any(value is not None for pair in values.values() for value in pair.values()) else None


@lru_cache(maxsize=256)
def _district_potential(code, _hour):
    data = _row(_post("/gcs/poten/selectSolarPotentialBySigCd_KIER.do", json={"sigCd": code}))
    row = _row(data.get("data"))
    if data.get("success") is not True or _text(row.get("sigcd")) != code:
        return None
    return {"name": _text(row.get("sigunnm")), **_sizes(row, "thrygenqyground", "thrygenqyroof")}


@lru_cache(maxsize=1024)
def _generation(code, _hour):
    data = _row(_post("/gcs/status/selectSolarSummaryAllByInstallType.do", json={"stdgCd": code}))
    rows = data.get("result")
    if not isinstance(rows, list):
        return None
    row = next((item for item in rows if _text(_row(item).get("stdgCd")) == code), None)
    if row is None:
        return None
    return {"annual_kwh": _number(row.get("genqy")), "panel_area_m2": _number(row.get("totalArea", row.get("total_area"))),
            "rank": _number(row.get("rank")), "rank_area": _text(row.get("siNm"))}


@lru_cache(maxsize=1024)
def _generation_mix(code, _hour):
    data = _row(_post("/gcs/status/selectAnnualForecastByInstallTypeStdgCd.do", json={"stdgCd": code}))
    rows = _row(data.get("result")).get("list")
    if not isinstance(rows, list):
        return []
    mix = {}
    for entry in rows:
        row = _row(entry)
        label, value = _text(row.get("instlTypeNm")), _number(row.get("genqy"))
        if _text(row.get("stdgCd")) == code and label and value is not None:
            mix[label] = mix.get(label, 0) + value
    return [{"name": label, "annual_kwh": value} for label, value in sorted(mix.items(), key=lambda pair: -pair[1])]


def _read(future, fallback):
    try:
        return future.result()
    except (httpx.HTTPError, ValueError):
        return fallback


def _locate(latitude, longitude, hour):
    if not (36.6 <= latitude <= 38.5 and 125.9 <= longitude <= 128):
        return {"status": "outside", "location": None}, {}
    status = "unmatched"
    try:
        position = {key: value for key, value in _position(round(latitude, 6), round(longitude, 6), hour).items() if _text(value)}
    except (httpx.HTTPError, ValueError):
        position = {}
        status = "unavailable"
    if not _code(position.get("hjd2506_cd")) or not _legal_code(position) or not (position.get("sgg_nm") or position.get("cur_sgg_nm")):
        try:
            boundary_status, fallback = _boundary_position(latitude, longitude, hour // 24, position)
            if not position:
                status = boundary_status
            position = {**fallback, **position}
        except (httpx.HTTPError, ValueError, ShapelyError, TypeError):
            if not position:
                status = "unavailable"
    district = _text(position.get("cur_sgg_nm")) or _text(position.get("sgg_nm"))
    admin = _text(position.get("hjd2506_nm")) or _text(position.get("hjd_nm"))
    legal = _text(position.get("cur_stdg_nm")) or _text(position.get("stdg_nm"))
    if not district:
        return {"status": status, "location": None}, {}
    available = bool(_code(position.get("hjd2506_cd")) or _legal_code(position))
    return {"status": "available" if available else "unmatched",
            "location": {"district": district, "administrative": admin, "legal": legal}}, position


def location_at(latitude, longitude):
    location, _ = _locate(latitude, longitude, int(time.time() // 3600))
    return location


def at(latitude, longitude):
    """Identify the point, then fetch each statistic using its own boundary code."""
    hour = int(time.time() // 3600)
    region, position = _locate(latitude, longitude, hour)
    result = {**region, "potential": None, "district_potential": None,
              "generation": None, "generation_mix": [], "source_url": SOURCE_URL}
    if not position:
        return result
    admin_code = _code(position.get("hjd2506_cd"))
    legal_code = _legal_code(position)
    jobs = {}
    if admin_code:
        jobs["potential"] = _workers.submit(_potential, admin_code, hour)
        jobs["district_potential"] = _workers.submit(_district_potential, admin_code[:5], hour)
    if legal_code:
        jobs["generation"] = _workers.submit(_generation, legal_code, hour)
        jobs["generation_mix"] = _workers.submit(_generation_mix, legal_code, hour)
    for key, future in jobs.items():
        result[key] = _read(future, result[key])
    if result["generation"]:
        city = _text(position.get("sigun_nm"))
        if city:
            result["generation"] = {**result["generation"], "rank_area": city}
    return result
