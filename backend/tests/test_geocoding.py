import concurrent.futures
import math

import httpx
import pytest
from fastapi.testclient import TestClient

from app import geocoding
from app.main import create_app
from app.store import LocalRepository


@pytest.fixture(autouse=True)
def isolated_geocoder(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "local")
    monkeypatch.setattr(geocoding, "_cache", geocoding.OrderedDict())
    monkeypatch.setattr(geocoding, "_last_request_at", None)
    monkeypatch.setattr(geocoding, "_request_upstream", lambda query: pytest.fail("Unexpected live geocoder request"))


@pytest.mark.parametrize("query,label", [
    ("수원", "경기도 수원시"), ("경기 수원", "경기도 수원시"), ("경기도 수원시", "경기도 수원시"),
    ("대한민국 경기도 수원시", "경기도 수원시"), ("양평군", "경기도 양평군"),
    ("충주", "충청북도 충주시"), ("합천", "경상남도 합천군"), ("서울", "서울특별시"),
    ("전라남도", "전라남도"), ("전북", "전북특별자치도"), ("전라북도 전주시", "전북특별자치도 전주시"),
    ("세종시", "세종특별자치시"), ("강원도 고성군", "강원특별자치도 고성군"),
    ("경남 고성", "경상남도 고성군"), ("Seoul", "서울특별시"),
    ("대한민국", "대한민국"), ("한국", "대한민국"), ("전국", "대한민국"),
])
def test_known_regions_and_aliases_are_offline(query, label):
    result = geocoding.search_places(query)
    assert label in [row["label"] for row in result["results"]]
    assert result["provider"] == "local"
    assert result["warning"] is None


def test_region_viewports_and_ambiguous_names():
    assert len(geocoding.REGIONS) >= 170
    assert len(geocoding.search_places("고성")["results"]) == 2
    assert len(geocoding.search_places("광주")["results"]) == 2
    for row, aliases in geocoding.REGIONS:
        assert aliases
        west, south, east, north = row["bbox"]
        assert 124 <= west <= row["longitude"] <= east <= 132
        assert 33 <= south <= row["latitude"] <= north <= 39
        assert row["kind"] == "region"


def test_coordinates_are_exact_and_defensive_copies():
    result = geocoding.search_places("37.2636, 127.0286")
    assert result["results"][0]["latitude"] == 37.2636
    assert result["results"][0]["longitude"] == 127.0286
    assert result["results"][0]["kind"] == "place"
    result = geocoding.search_places("수원")
    result["results"][0]["bbox"][0] = 0
    assert geocoding.search_places("수원")["results"][0]["bbox"][0] > 120


@pytest.mark.parametrize("query", ["", "수", "   ", "x" * 121, "91, 127", "37, 181"])
def test_invalid_queries_raise_value_error(query):
    with pytest.raises(ValueError):
        geocoding.search_places(query)


def test_detailed_addresses_do_not_silently_become_region_matches():
    result = geocoding.search_places("수원시 팔달구 효원로 241")
    assert result["provider"] == "local"
    assert result["warning"]
    assert any(row["label"] == "경기도 수원시" for row in result["results"])


UPSTREAM_ROW = {"place_id": 12, "osm_type": "way", "osm_id": 123, "lat": "37.2636", "lon": "127.0286",
                "boundingbox": ["37.2630", "37.2640", "127.0280", "127.0290"],
                "display_name": "수원시청, 효원로, 수원시, 경기도, 대한민국", "category": "office"}


def test_opt_in_remote_parameters_and_bounding_box(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "nominatim")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=[UPSTREAM_ROW])

    real_client = httpx.Client
    monkeypatch.setattr(geocoding.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(geocoding, "_request_upstream", _ORIGINAL_REQUEST_UPSTREAM)
    result = geocoding.search_places("수원시청")
    assert result["provider"] == "nominatim"
    assert result["warning"] is None
    assert result["results"][0]["bbox"] == [127.028, 37.263, 127.029, 37.264]
    assert result["results"][0]["source"] == "nominatim"
    assert "OpenStreetMap" in result["attribution"]
    assert calls[0].url.host == "nominatim.openstreetmap.org"
    assert calls[0].url.params["countrycodes"] == "kr"
    assert calls[0].url.params["accept-language"] == "ko"
    assert calls[0].url.params["limit"] == "5"
    assert calls[0].headers["user-agent"] == geocoding.USER_AGENT


_ORIGINAL_REQUEST_UPSTREAM = geocoding._request_upstream


def test_remote_cache_deduplicates_concurrent_queries(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "nominatim")
    requests = []
    monkeypatch.setattr(geocoding, "_request_upstream", lambda query: requests.append(query) or [UPSTREAM_ROW])
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        results = list(executor.map(geocoding.search_places, ["수원시청"] * 5))
    assert len(requests) == 1
    results[0]["results"][0]["label"] = "changed"
    assert results[1]["results"][0]["label"] != "changed"


def test_remote_rate_limit_and_cache_expiry(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "nominatim")
    now = [100.0]
    waits, requests = [], []
    monkeypatch.setattr(geocoding.time, "monotonic", lambda: now[0])

    def sleep(seconds):
        waits.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(geocoding.time, "sleep", sleep)
    monkeypatch.setattr(geocoding, "_request_upstream", lambda query: requests.append(query) or [UPSTREAM_ROW])
    geocoding.search_places("수원시청")
    geocoding.search_places("양평군청")
    assert waits == [1.0]
    geocoding.search_places("수원시청")
    assert len(requests) == 2
    now[0] += geocoding.CACHE_TTL + 1
    geocoding.search_places("수원시청")
    assert len(requests) == 3


@pytest.mark.parametrize("failure", [httpx.ConnectTimeout("timeout"), httpx.HTTPStatusError("limited", request=httpx.Request("GET", "https://nominatim.openstreetmap.org/search"), response=httpx.Response(429))])
def test_remote_errors_fall_back_without_leaking_error_details(monkeypatch, failure):
    monkeypatch.setenv("GEOCODING_PROVIDER", "nominatim")
    requests = []

    def fail(query):
        requests.append(query)
        raise failure

    monkeypatch.setattr(geocoding, "_request_upstream", fail)
    result = geocoding.search_places("수원시청")
    assert result["provider"] == "local"
    assert result["warning"]
    assert result["results"][0]["label"] == "경기도 수원시"
    assert geocoding.search_places("수원시청") == result
    assert len(requests) == 1


def test_malformed_remote_results_are_skipped(monkeypatch):
    monkeypatch.setenv("GEOCODING_PROVIDER", "nominatim")
    invalid = [{**UPSTREAM_ROW, "lat": "nan"}, {**UPSTREAM_ROW, "boundingbox": [1, 2]},
               {**UPSTREAM_ROW, "lon": "999"}, None, {**UPSTREAM_ROW, "display_name": ""}]
    monkeypatch.setattr(geocoding, "_request_upstream", lambda query: invalid)
    result = geocoding.search_places("알수없는장소")
    assert result["results"] == []
    assert result["warning"]


def test_api_validation_and_response_contract(tmp_path):
    repository = LocalRepository(tmp_path / "geocoder.sqlite3")
    try:
        with TestClient(create_app(repository, seed=False)) as client:
            for query in ("", "수", "  ", "x" * 121, "91, 127"):
                assert client.get("/api/geocoding/search", params={"q": query}).status_code == 422
            response = client.get("/api/geocoding/search", params={"q": "양평"})
            assert response.status_code == 200
            result = response.json()
            assert set(result) == {"results", "provider", "warning", "attribution"}
            row = result["results"][0]
            assert set(row) == {"id", "label", "latitude", "longitude", "bbox", "source", "kind"}
            assert all(math.isfinite(value) for value in row["bbox"])
    finally:
        repository.close()
