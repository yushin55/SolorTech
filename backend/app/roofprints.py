"""Full building footprints from Overture's spatially indexed public release."""

import io
import os
import re
from functools import lru_cache
from threading import Lock

import httpx
from shapely import from_wkb, orient_polygons
from shapely.geometry import Point, mapping, shape

from . import sitefinder, waterbodies as osm

RELEASE = "2026-11-18.0"
ATTRIBUTION = "Overture Maps Foundation · 건축물 외곽"
CACHE = f"overture-buildings-{RELEASE}"
_read_lock = Lock()


@lru_cache(maxsize=1)
def _index():
    import pyarrow.parquet as parquet

    response = httpx.get(f"https://stac.overturemaps.org/{RELEASE}/collections.parquet", timeout=8)
    response.raise_for_status()
    return parquet.read_table(io.BytesIO(response.content), columns=["collection", "type", "bbox", "assets"])


@lru_cache(maxsize=1)
def _filesystem():
    from pyarrow.fs import S3FileSystem

    return S3FileSystem(anonymous=True, region="us-west-2", connect_timeout=4, request_timeout=8)


def _fetch(bounds):
    import pyarrow.compute as pc
    import pyarrow.dataset as ds

    west, south, east, north = bounds
    intersects = ((pc.field("bbox", "xmin") <= east) & (pc.field("bbox", "xmax") >= west)
                  & (pc.field("bbox", "ymin") <= north) & (pc.field("bbox", "ymax") >= south))
    index = _index().filter((pc.field("collection") == "building") & (pc.field("type") == "Feature") & intersects)
    paths = []
    prefix = f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/"
    for assets in index["assets"].to_pylist():
        href = assets["aws"]["alternate"]["s3"]["href"]
        if href.startswith(prefix) and href.endswith(".parquet"):
            paths.append(href.removeprefix("s3://"))
    if not paths:
        return []
    dataset = ds.dataset(paths, filesystem=_filesystem(), format="parquet")
    table = dataset.to_table(filter=intersects, columns=["id", "geometry", "names", "sources", "subtype",
                                                       "class", "num_floors", "height", "roof_shape", "is_underground"])
    return table.to_pylist()


def _features(raw):
    for row in raw:
        if row["is_underground"] or not row["geometry"]:
            continue
        geometry = from_wkb(row["geometry"], on_invalid="ignore")
        if geometry is None or geometry.is_empty or not geometry.is_valid:
            continue
        if geometry.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        sources = row.get("sources") or []
        root = next((s for s in sources if not s.get("property")), {})
        osm_id = re.fullmatch(r"([wr])(\d+)(?:@\d+)?", root.get("record_id") or "") if root.get("provider") == "osm" else None
        identifier = f"{'way' if osm_id[1] == 'w' else 'relation'}/{osm_id[2]}" if osm_id else f"overture/{row['id']}"
        names = row.get("names") or {}
        name = (dict(names.get("common") or []).get("ko") or names.get("primary") or "").strip()[:100] or None
        kind = next((sitefinder.BUILDING_LABELS[value] for value in (row["class"], row["subtype"])
                     if value in sitefinder.BUILDING_LABELS), "건축물")
        attribution = "Overture Maps Foundation"
        if root.get("provider") == "osm":
            attribution += " · © OpenStreetMap contributors (ODbL)"
        elif root.get("resource") == "east_asian_buildings":
            attribution += " · Qian Shi et al., East Asian Buildings (CC BY 4.0)"
        elif root.get("dataset"):
            attribution += f" · {root['dataset']}"
        polygons = geometry.geoms if geometry.geom_type == "MultiPolygon" else [geometry]
        for index, polygon in enumerate(sorted(polygons, key=lambda p: p.area, reverse=True)):
            polygon = osm._fit(polygon, preserve_small_holes=True)
            if polygon is None:
                continue
            point = polygon.representative_point()
            yield {"id": f"{identifier}-{index}" if index else identifier, "name": name, "kind": kind,
                   "feature_type": "building", "data_source": attribution, "geometry": mapping(polygon),
                   "area_m2": round(osm._area_m2(orient_polygons(polygon)), 1), "latitude": point.y, "longitude": point.x,
                   "building_info": {"address": None, "levels": str(row["num_floors"]) if row["num_floors"] else None,
                                     "height": f"{row['height']:g}" if row["height"] else None, "roof_shape": row["roof_shape"]}}


def viewport(west, south, east, north):
    osm._validate_bbox(west, south, east, north, .08, .06)
    if os.getenv("ROOFPRINT_PROVIDER", "overture").lower() == "off":
        raise PermissionError("추가 건축물 경계 연결이 꺼져 있습니다.")
    bounds = (west, south, east, north)
    key = osm._snap(*bounds, step=100)
    rows = osm._read_disk(key, CACHE)
    if rows is None:
        with _read_lock:
            rows = osm._read_disk(key, CACHE)
            if rows is None:
                try:
                    rows = list(_features(_fetch(key)))
                except (httpx.HTTPError, ImportError, OSError, KeyError, TypeError, ValueError) as error:
                    raise ConnectionError("추가 건축물 경계를 불러오지 못했습니다.") from error
                osm._write_disk(key, rows, CACHE)
    return [row for row in rows if osm._intersects(row, *bounds)]


def identify(latitude, longitude):
    if not (33 <= latitude <= 39 and 124 <= longitude <= 132):
        raise ValueError("국내 위치의 건축물만 선택할 수 있습니다.")
    epsilon = .000001
    point = Point(longitude, latitude)
    roofs = viewport(longitude - epsilon, latitude - epsilon, longitude + epsilon, latitude + epsilon)
    return min((roof for roof in roofs if shape(roof["geometry"]).covers(point)),
               key=lambda roof: (roof["area_m2"], roof["id"]), default=None)
