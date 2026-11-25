import pytest
from fastapi.testclient import TestClient

from app import mapfeatures, waterbodies
from app.main import create_app
from app.store import LocalRepository


def ring(lon, lat, size):
    return [{"lon": x, "lat": y} for x, y in [(lon, lat), (lon + size, lat),
            (lon + size, lat + size), (lon, lat + size), (lon, lat)]]


PAYLOAD = {"elements": [
    {"type": "way", "id": 1, "tags": {"landuse": "farmland", "name": "농지"}, "geometry": ring(127, 37, .005)},
    {"type": "way", "id": 2, "tags": {"natural": "water", "water": "pond", "name": "작은 수면"}, "geometry": ring(127.001, 37.001, .0005)},
    {"type": "way", "id": 3, "tags": {"building": "yes", "name": "작은 건물"}, "geometry": ring(127.0011, 37.0011, .00002)},
    {"type": "way", "id": 4, "tags": {"landuse": "forest", "name": "산림"}, "geometry": ring(127.006, 37.006, .003)},
]}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("WATER_PROVIDER", "overpass")
    monkeypatch.setenv("WATER_CACHE_DIR", str(tmp_path / "map"))
    monkeypatch.setattr(waterbodies, "_cache", waterbodies.OrderedDict())
    monkeypatch.setattr(waterbodies, "_last_request_at", None)
    monkeypatch.setattr(waterbodies, "_request", lambda query: PAYLOAD)


def test_viewport_contains_all_types_without_candidate_size_or_land_filters():
    result = mapfeatures.viewport(127, 37, 127.009, 37.009)
    rows = {row["id"]: row for row in result["results"]}
    assert result["total"] == 4
    assert rows["way/3"]["feature_type"] == "building" and rows["way/3"]["area_m2"] < 30
    assert rows["way/2"]["feature_type"] == "water" and rows["way/2"]["area_m2"] < 10000
    assert rows["way/1"]["kind"] == "농지" and rows["way/4"]["kind"] == "산림"
    assert rows["way/1"]["feature_type"] == rows["way/4"]["feature_type"] == "land"


def test_all_boundaries_are_returned_instead_of_largest_500(monkeypatch):
    payload = {"elements": [{"type": "way", "id": i, "tags": {"building": "yes"},
                           "geometry": ring(127 + (i % 25) * .0002, 37 + (i // 25) * .0002, .00003)} for i in range(550)]}
    monkeypatch.setattr(waterbodies, "_request", lambda query: payload)
    assert mapfeatures.viewport(127, 37, 127.009, 37.009)["total"] == 550


def test_identification_uses_actual_containing_object_and_prioritizes_roof_then_water_then_land():
    assert mapfeatures.identify(37.00111, 127.00111)["feature"]["id"] == "way/3"
    assert mapfeatures.identify(37.0013, 127.0013)["feature"]["id"] == "way/2"
    assert mapfeatures.identify(37.004, 127.004)["feature"]["id"] == "way/1"
    assert mapfeatures.identify(37.008, 127.008)["feature"]["id"] == "way/4"
    assert mapfeatures.identify(37.02, 127.02)["feature"] is None


def test_courtyards_and_water_holes_remain_unselectable_as_the_outer_feature(monkeypatch):
    payload = {"elements": [{"type": "relation", "id": 9, "tags": {"natural": "water"}, "members": [
        {"type": "way", "role": "outer", "geometry": ring(127, 37, .003)},
        {"type": "way", "role": "inner", "geometry": ring(127.001, 37.001, .00005)},
    ]}]}
    monkeypatch.setattr(waterbodies, "_request", lambda query: payload)
    assert mapfeatures.identify(37.00102, 127.00102)["feature"] is None
    assert mapfeatures.identify(37.0005, 127.0005)["feature"]["feature_type"] == "water"


def test_cached_viewport_and_point_click_share_complete_geometry_without_another_request(monkeypatch):
    calls = []
    monkeypatch.setattr(waterbodies, "_request", lambda query: calls.append(query) or PAYLOAD)
    first = mapfeatures.viewport(127.0005, 37.0005, 127.009, 37.009)
    with waterbodies._lock:
        selected = mapfeatures.identify(37.0013, 127.0013)["feature"]
    assert selected == next(row for row in first["results"] if row["id"] == "way/2")
    assert len(calls) == 1
    assert "is_in" in calls[0] and "pivot.covered" in calls[0]


def test_api_validates_viewports_and_does_not_turn_failed_queries_into_empty_maps(monkeypatch, tmp_path):
    client = TestClient(create_app(LocalRepository(str(tmp_path / "db.sqlite3"))))
    assert client.get("/api/map-features", params={"west": 127, "south": 37, "east": 127.009, "north": 37.009}).json()["total"] == 4
    assert client.get("/api/map-features/identify", params={"latitude": 37.00111, "longitude": 127.00111}).json()["feature"]["id"] == "way/3"
    assert client.get("/api/map-features", params={"west": 127, "south": 37, "east": 129, "north": 38}).status_code == 422
    assert client.get("/api/map-features/identify", params={"latitude": 1, "longitude": 127}).status_code == 422
    monkeypatch.setenv("WATER_PROVIDER", "off")
    assert client.get("/api/map-features", params={"west": 127, "south": 37, "east": 127.009, "north": 37.009}).status_code == 503
    with pytest.raises(ValueError):
        mapfeatures._parse({"elements": [], "remark": "runtime error: Query timed out"})
