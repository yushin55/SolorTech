import httpx
import pytest
from fastapi.testclient import TestClient

from app import regulations
from app.main import create_app
from app.store import LocalRepository


def polygon(west, south, east, north, holes=None):
    return {"type": "Polygon", "coordinates": [
        [[west, south], [east, south], [east, north], [west, north], [west, south]], *(holes or [])]}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.delenv("GG_CLIMATE_API_KEY", raising=False)
    monkeypatch.setattr(regulations, "_cache", regulations.OrderedDict())


def test_missing_key_is_unknown_and_never_clear():
    result = regulations.check({"latitude": 37.3, "longitude": 127.0})
    assert result["status"] == "unavailable"
    assert len(result["items"]) == 17
    assert all(item["status"] == "unknown" for item in result["items"])


def test_boundary_intersection_includes_edges_and_respects_holes(monkeypatch):
    monkeypatch.setenv("GG_CLIMATE_API_KEY", "test-secret")
    # The centre is outside this zone, but the site's eastern edge overlaps.
    zone = polygon(127.01, 37.30, 127.03, 37.32)
    captured = []
    def fetch(layer, bounds):
        captured.append(bounds)
        return {"id": layer, "complete": True, "features": [
            {"type": "Feature", "geometry": zone, "properties": {}}
        ] if layer == regulations.LAYERS[0][0] else []}
    monkeypatch.setattr(regulations, "_fetch", fetch)
    result = regulations.check({"latitude": 37.305, "longitude": 127.0,
                                "geometry": polygon(126.99, 37.30, 127.02, 37.31)})
    assert result["items"][0]["status"] == "overlap"
    assert result["basis"] == "후보지 전체 경계"
    assert captured[0][0] < 126.99 and captured[0][2] > 127.02
    hole = zone["coordinates"][0]
    result = regulations.check({"latitude": 37.305, "longitude": 127.0,
                                "geometry": polygon(126.9, 37.2, 127.1, 37.39, [hole])})
    # Boundary contact is conservatively reported as overlap, even on hole edges.
    assert result["items"][0]["status"] == "overlap"
    zone["coordinates"] = polygon(127.012, 37.302, 127.028, 37.318)["coordinates"]
    result = regulations.check({"latitude": 37.305, "longitude": 127.0,
                                "geometry": polygon(126.9, 37.2, 127.1, 37.39, [hole])})
    assert result["items"][0]["status"] == "clear"


def test_partial_layers_never_become_clear(monkeypatch):
    monkeypatch.setenv("GG_CLIMATE_API_KEY", "test-secret")
    monkeypatch.setattr(regulations, "_fetch", lambda layer, bounds: {
        "id": layer, "complete": layer != regulations.LAYERS[0][0], "features": []})
    result = regulations.check({"latitude": 37.3, "longitude": 127.0})
    assert result["status"] == "partial"
    assert result["items"][0]["status"] == "unknown"
    assert result["items"][1]["status"] == "clear"


def test_wfs_axes_cache_truncation_and_no_key_leak(monkeypatch):
    monkeypatch.setenv("GG_CLIMATE_API_KEY", "test-secret")
    calls = []
    def get(client, url, params):
        calls.append(params)
        return httpx.Response(200, request=httpx.Request("GET", url), json={
            "type": "FeatureCollection", "features": [], "totalFeatures": 2})
    monkeypatch.setattr(httpx.Client, "get", get)
    bounds = (127, 37.2, 127.1, 37.3)
    result = regulations._fetch("drinking_water_protection_area", bounds)
    assert calls[0]["bbox"] == "37.2,127,37.3,127.1,EPSG:4326"
    assert calls[0]["srsName"] == "EPSG:4326"
    assert result["complete"] is False  # omitted features, not a clear zone
    def offline(*args, **kwargs):
        raise httpx.ConnectError("https://example.invalid/?apiKey=test-secret")
    monkeypatch.setattr(httpx.Client, "get", offline)
    result = regulations._fetch("drinking_water_protection_area", bounds)
    assert result["complete"] is False and "test-secret" not in str(result)
    assert "test-secret" not in str(regulations.catalog())


def test_api_validates_bounds_and_geometry_and_exposes_configuration(tmp_path):
    client = TestClient(create_app(LocalRepository(str(tmp_path / "db.sqlite3"))))
    assert client.get("/api/regulations/catalog").json()["configured"] is False
    assert client.get("/api/regulations", params={"west": 127, "south": 37, "east": 128, "north": 38}).status_code == 422
    body = {"name": "건물", "latitude": 37.3, "longitude": 127.0}
    result = client.post("/api/regulations/check", json=body)
    assert result.status_code == 200 and result.json()["status"] == "unavailable"
    assert client.post("/api/regulations/check", json={**body, "geometry": polygon(0, 0, 0, 0)}).status_code == 422
    assert client.post("/api/regulations/check", json={**body, "latitude": 35.0}).json()["status"] == "outside"
