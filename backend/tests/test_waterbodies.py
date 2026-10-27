import pytest
from fastapi.testclient import TestClient

from app import geocoding, waterbodies
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
