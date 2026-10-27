"""Conceptual rectangle placement in a metre-based local projection."""

import math

from pyproj import CRS, Geod, Transformer
from shapely import affinity
from shapely.geometry import box, mapping, shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep

from .common import integer, number


def _polygon(geometry, label):
    try:
        polygon = shape(geometry)
    except (TypeError, ValueError, KeyError, AttributeError) as exc:
        raise ValueError(f"{label}: 올바른 GeoJSON Polygon이 필요합니다.") from exc
    if polygon.geom_type != "Polygon" or polygon.is_empty or not polygon.is_valid:
        raise ValueError(f"{label}: 교차하지 않는 유효한 Polygon이 필요합니다.")
    minimum_x, minimum_y, maximum_x, maximum_y = polygon.bounds
    if not all(math.isfinite(value) for value in polygon.bounds):
        raise ValueError(f"{label}: 유효한 경위도가 필요합니다.")
    if minimum_x < -180 or maximum_x > 180 or minimum_y < -89 or maximum_y > 89:
        raise ValueError(f"{label}: GeoJSON 좌표는 [경도, 위도]이어야 합니다.")
    if maximum_x - minimum_x > 1 or maximum_y - minimum_y > 1:
        raise ValueError(f"{label}: 개략 배치용 영역은 경위도 폭 1° 이내로 제한합니다.")
    return polygon


def projection_for(candidate):
    latitude = number(candidate, "latitude", minimum=-89, maximum=89)
    longitude = number(candidate, "longitude", minimum=-180, maximum=180)
    local = CRS.from_proj4(f"+proj=aeqd +lat_0={latitude} +lon_0={longitude} +datum=WGS84 +units=m +no_defs")
    return (Transformer.from_crs("EPSG:4326", local, always_xy=True),
            Transformer.from_crs(local, "EPSG:4326", always_xy=True))


def connection_distance(candidate):
    """Use the reviewed cable route input, else geodesic site-centre/grid distance."""
    explicit = candidate.get("cable_distance_m")
    if explicit is not None:
        return number(candidate, "cable_distance_m", minimum=0), "사용자 입력 케이블 거리"
    grid = candidate.get("grid_point")
    if grid is None:
        return 0., "연결점 미입력: 케이블 거리를 0m로 가정"
    if not isinstance(grid, (list, tuple)) or len(grid) != 2:
        raise ValueError("grid_point: [경도, 위도] 좌표가 필요합니다.")
    longitude = number({"lng": grid[0]}, "lng", minimum=-180, maximum=180)
    latitude = number({"lat": grid[1]}, "lat", minimum=-90, maximum=90)
    _, _, distance = Geod(ellps="WGS84").inv(candidate["longitude"], candidate["latitude"], longitude, latitude)
    return float(distance), "후보지 기준좌표와 육상 연결점 사이 WGS84 직선거리 (실제 케이블 경로 미검증)"


def calculate_layout(candidate, equipment):
    """Place requested modules, rejecting boundary/exclusion crossings.

    Layout uses actual module dimensions as conservative plan envelopes, rotates
    the grid with azimuth, and leaves row_spacing_m between rows. No engineering
    feasibility or structural/mooring validation is implied.
    """
    outer = _polygon(candidate.get("geometry"), "후보지 경계")
    exclusions = [_polygon(value, "제외구역") for value in candidate.get("exclusions", [])]
    forward, inverse = projection_for(candidate)
    projected = transform(forward.transform, outer)
    if not math.isfinite(projected.area) or projected.area <= 0 or not projected.is_valid:
        raise ValueError("후보지 기준 좌표와 경계를 확인해 주세요. 유효한 지역 면적을 계산할 수 없습니다.")
    # Distant exclusions do not affect this site and need not be projected.
    projected_exclusions = [transform(forward.transform, exclusion.intersection(outer)) for exclusion in exclusions]
    usable = projected.difference(unary_union(projected_exclusions)) if exclusions else projected
    requested = integer(equipment, "module_count", minimum=0, maximum=100000)
    width = number(equipment, "module_width_m", default=1.134, minimum=.05, maximum=10)
    height = number(equipment, "module_height_m", default=2.278, minimum=.05, maximum=20)
    spacing = number(equipment, "row_spacing_m", default=1.5, minimum=0, maximum=100)
    azimuth = number(equipment, "azimuth", default=180, minimum=0, maximum=360)
    angle = 180 - azimuth
    aligned = affinity.rotate(usable, -angle, origin=(0, 0))
    warnings = ["개략 모듈 배치입니다. 부유체·통로·계류·행간 그늘·구조 안전 및 규제상 설치 가능성을 검증하지 않았습니다."]
    modules = []
    if not aligned.is_empty and requested:
        min_x, min_y, max_x, max_y = aligned.bounds
        pitch = height + spacing
        prepared = prep(aligned)
        # Grow a square window around the site reference point (the origin) so a
        # small array on a large reservoir is placed as one compact block.
        half = math.sqrt(requested * width * pitch) * .75
        tested = 0
        while True:
            modules = []
            first_column = max(0, math.floor((-half - min_x) / width))
            last_column = min(math.floor((max_x - min_x + 1e-7) / width), math.ceil((half - min_x) / width))
            first_row = max(0, math.floor((-half - min_y) / pitch))
            last_row = min(math.floor((max_y - min_y + spacing + 1e-7) / pitch), math.ceil((half - min_y) / pitch))
            stop = False
            for row in range(first_row, last_row):
                y = min_y + row * pitch
                for column in range(first_column, last_column):
                    tested += 1
                    if tested > 250000:
                        warnings.append("넓은 영역의 탐색 한도에 도달했습니다. 영역 또는 수량을 줄여 배치를 확인하세요.")
                        stop = True
                        break
                    x = min_x + column * width
                    rectangle = box(x, y, x + width, y + height)
                    if prepared.covers(rectangle):
                        rectangle = affinity.rotate(rectangle, angle, origin=(0, 0))
                        modules.append(mapping(transform(inverse.transform, rectangle)))
                        if len(modules) >= requested:
                            stop = True
                            break
                if stop:
                    break
            covers_all = -half <= min_x and half >= max_x and -half <= min_y and half >= max_y
            if len(modules) >= requested or tested > 250000 or covers_all:
                break
            half *= 2
    if len(modules) < requested:
        warnings.append(f"요청 {requested:,}개 중 {len(modules):,}개만 배치됩니다. 수량 또는 경계·제외구역·간격을 조정하세요.")
    return {
        "module_count": len(modules), "requested_count": requested,
        "area_m2": float(projected.area), "usable_area_m2": float(usable.area),
        "coverage_pct": len(modules) * width * height / projected.area * 100,
        "modules": modules, "warnings": warnings,
    }
