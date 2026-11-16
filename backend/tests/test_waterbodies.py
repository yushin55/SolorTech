import pytest
from fastapi.testclient import TestClient

from app import geocoding, sitefinder, waterbodies
from app.main import create_app
from app.schemas import CandidateCreate
from app.store import LocalRepository


def ring(west, south, size):
    """A closed square ring as Overpass geometry points (lat/lon objects)."""
    points = [(west, south), (west + size, south), (west + size, south + size), (west, south + size), (west, south)]
    return [{"lat": lat, "lon": lon} for lon, lat in points]


PAYLOAD = {"elements": [
    {"type": "way", "id": 1, "tags": {"natural": "water", "water": "reservoir", "name": "큰저수지"},
     "geometry": ring(127.0, 36.0, 0.01)},
    {"type": "way", "id": 2, "tags": {"natural": "water", "water": "river", "name": "강"},
     "geometry": ring(127.02, 36.0, 0.02)},
    {"type": "way", "id": 3, "tags": {"natural": "water", "water": "pond"},
     "geometry": ring(127.05, 36.0, 0.0002)},  # about 0.04 ha: below the 1 ha floor
    {"type": "relation", "id": 4, "tags": {"landuse": "reservoir", "name": "섬저수지"}, "members": [
        {"type": "way", "role": "outer", "geometry": ring(127.1, 36.1, 0.004)[:3]},
        {"type": "way", "role": "outer", "geometry": ring(127.1, 36.1, 0.004)[2:]},
        {"type": "way", "role": "inner", "geometry": ring(127.101, 36.101, 0.001)},
    ]},
]}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("WATER_PROVIDER", "overpass")
    monkeypatch.setenv("WATER_CACHE_DIR", str(tmp_path / "water"))
    monkeypatch.setattr(waterbodies, "_cache", waterbodies.OrderedDict())
    monkeypatch.setattr(waterbodies, "_last_request_at", None)
    monkeypatch.setattr(waterbodies, "_request", lambda query: pytest.fail("Unexpected live Overpass request"))


def test_parse_keeps_standing_water_and_islands():
    rows = waterbodies._parse(PAYLOAD)
    assert [r["name"] for r in rows] == ["큰저수지", "섬저수지"]
    big, island = rows
    assert big["kind"] == "저수지" and 95 < big["area_m2"] / 1e4 < 105
    assert len(island["geometry"]["coordinates"]) == 2  # the island stays a hole
    for row in rows:  # every result is directly usable as a candidate boundary
        CandidateCreate(name=row["name"], latitude=row["latitude"], longitude=row["longitude"], geometry=row["geometry"])


def test_search_snaps_caches_on_disk_and_filters_to_view(monkeypatch):
    queries = []
    monkeypatch.setattr(waterbodies, "_request", lambda query: queries.append(query) or PAYLOAD)
    first = waterbodies.find_water_bodies(127.0, 36.0, 127.05, 36.05)
    assert [r["name"] for r in first["results"]] == ["큰저수지"]
    assert "36.0,127.0,36.1,127.1" in queries[0]
    monkeypatch.setattr(waterbodies, "_cache", waterbodies.OrderedDict())  # only the disk copy remains
    second = waterbodies.find_water_bodies(127.0, 36.05, 127.1, 36.1)
    assert len(queries) == 1
    assert [r["name"] for r in second["results"]] == ["섬저수지"]


@pytest.mark.parametrize("bbox", [(127.0, 36.0, 128.0, 36.1), (127.1, 36.0, 127.0, 36.1), (127.0, 36.0, 127.1, float("nan"))])
def test_rejects_wide_or_invalid_views(bbox):
    with pytest.raises(ValueError):
        waterbodies.find_water_bodies(*bbox)


def test_api_maps_errors(monkeypatch, tmp_path):
    client = TestClient(create_app(LocalRepository(str(tmp_path / "db.sqlite3"))))
    assert client.get("/api/water-bodies", params={"west": 127, "south": 36, "east": 129, "north": 37}).status_code == 422
    def offline(query):
        raise waterbodies.httpx.ConnectError("offline")
    monkeypatch.setattr(waterbodies, "_request", offline)
    response = client.get("/api/water-bodies", params={"west": 127, "south": 36, "east": 127.1, "north": 36.1})
    assert response.status_code == 502
    monkeypatch.setenv("WATER_PROVIDER", "off")
    assert client.get("/api/water-bodies", params={"west": 127, "south": 36, "east": 127.1, "north": 36.1}).status_code == 503


SITES = {"elements": [
    {"type": "way", "id": 11, "tags": {"building": "industrial"}, "geometry": ring(127.0, 36.0, 0.0006)},   # ~0.36 ha roof
    {"type": "way", "id": 12, "tags": {"building": "greenhouse"}, "geometry": ring(127.002, 36.0, 0.001)},
    {"type": "way", "id": 13, "tags": {"building": "yes"}, "geometry": ring(127.004, 36.0, 0.0002)},        # ~400 m2
    {"type": "way", "id": 14, "tags": {"amenity": "parking", "name": "공영주차장"}, "geometry": ring(127.01, 36.0, 0.001)},
    {"type": "way", "id": 15, "tags": {"amenity": "parking", "parking": "underground"}, "geometry": ring(127.02, 36.0, 0.001)},
    {"type": "way", "id": 16, "tags": {"landuse": "brownfield"}, "geometry": ring(127.03, 36.0, 0.002)},
    {"type": "way", "id": 17, "tags": {"landuse": "farmland"}, "geometry": ring(127.04, 36.0, 0.002)},
]}


def test_land_and_building_search_classifies_filters_and_caches_apart_from_water(monkeypatch, tmp_path):
    queries = []
    monkeypatch.setattr(waterbodies, "_request", lambda query: queries.append(query) or SITES)
    roofs = sitefinder.find_sites("building", 127.0, 36.0, 127.05, 36.05)
    assert roofs["site_type"] == "rooftop"
    assert [(r["id"], r["kind"]) for r in roofs["results"]] == [("way/11", "공장·산업시설"), ("way/13", "건축물")]
    assert '"building"' in queries[0] and "if:length()>19" in queries[0]
    land = sitefinder.find_sites("land", 127.0, 36.0, 127.05, 36.05)
    assert land["site_type"] == "land"
    assert [(r["name"], r["kind"]) for r in land["results"]] == [(None, "유휴 부지"), ("공영주차장", "주차장")]
    assert len(queries) == 2 and "farmland" not in queries[1]
    for found in (roofs, land):  # usable as a candidate boundary as returned
        for row in found["results"]:
            CandidateCreate(name=row["name"] or row["kind"], latitude=row["latitude"], longitude=row["longitude"],
                            geometry=row["geometry"], site_type=found["site_type"])
    # Repeat views are served from the per-layer cache; the reservoir seed lookup does not see these files.
    sitefinder.find_sites("building", 127.001, 36.001, 127.049, 36.049)
    assert len(queries) == 2
    assert not list((tmp_path / "water").glob("*.json")) and list((tmp_path / "water" / "building-v2").glob("*.json"))


def test_site_search_limits_and_api(monkeypatch, tmp_path):
    with pytest.raises(ValueError):
        sitefinder.find_sites("farm", 127.0, 36.0, 127.05, 36.05)
    with pytest.raises(ValueError):  # a town-sized window only: dense cities hold many roofs
        sitefinder.find_sites("building", 127.0, 36.0, 127.3, 36.05)
    monkeypatch.setattr(waterbodies, "_request", lambda query: {"elements": []})
    client = TestClient(create_app(LocalRepository(str(tmp_path / "db.sqlite3"))))
    box = {"west": 127, "south": 36, "east": 127.05, "north": 36.05}
    empty = client.get("/api/site-candidates", params={"kind": "land", **box})
    assert empty.status_code == 200 and "농지·임야는 검색하지 않습니다" in empty.json()["warning"]
    assert client.get("/api/site-candidates", params={"kind": "farm", **box}).status_code == 422
    monkeypatch.setenv("WATER_PROVIDER", "off")
    assert client.get("/api/site-candidates", params={"kind": "building", **box}).status_code == 503


def test_adjacent_small_buildings_are_individually_selectable(monkeypatch):
    # Both centroids round to the same 0.001-degree cell and both areas to 100 m².
    shape = ring(127.0001, 36.0001, 0.0001)
    payload = {"elements": [
        {"type": "way", "id": 21, "tags": {"building": "yes"}, "geometry": shape},
        {"type": "way", "id": 22, "tags": {"building": "yes"}, "geometry": ring(127.0003, 36.0001, 0.0001)},
        {"type": "way", "id": 23, "tags": {"building": "yes"}, "geometry": list(reversed(shape))},
        {"type": "way", "id": 24, "tags": {"building": "yes"}, "geometry": ring(127.0005, 36.0001, 0.00001)},
    ]}
    rows = waterbodies._parse(payload, sitefinder._building_kind, 30)
    assert {row["id"] for row in rows} == {"way/21", "way/22"}


def test_kakao_results_cover_apartments(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "kakao")
    monkeypatch.setenv("KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(geocoding, "_cache", geocoding.OrderedDict())
    monkeypatch.setattr(geocoding, "_request_kakao", lambda query: {"documents": [
        {"id": "1", "place_name": "래미안아파트", "road_address_name": "서울 서초구 반포대로 1", "x": "127.01", "y": "37.50"},
        {"id": "2", "place_name": "범위 밖", "x": "10", "y": "10"},
    ]})
    result = geocoding.search_places("래미안아파트")
    assert result["provider"] == "kakao"
    assert [r["label"] for r in result["results"]] == ["래미안아파트 · 서울 서초구 반포대로 1"]
    assert result["results"][0]["kind"] == "place"


def test_kakao_without_key_explains_setup(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "kakao")
    monkeypatch.delenv("KAKAO_REST_API_KEY", raising=False)
    monkeypatch.setattr(geocoding, "_request_kakao", lambda query: pytest.fail("No key, no request"))
    assert "KAKAO_REST_API_KEY" in geocoding.search_places("래미안아파트")["warning"]
