import httpx
import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box

from app import solar_regions
from app.main import create_app
from app.store import LocalRepository


def test_region_routes_use_different_codes_for_potential_and_generation(monkeypatch, tmp_path):
    calls = []

    def post(path, **kwargs):
        calls.append(path)
        params = kwargs.get("json", {})
        if path.endswith("selectUserPosition.do"):
            assert kwargs["data"]["st_x"] > 100_000
            return {"list": {"sigun_nm": "수원시", "sgg_nm": "수원시 영통구", "hjd2506_cd": "31014630", "hjd2506_nm": "광교2동",
                             "cur_stdg_cd": "41117104", "cur_stdg_nm": "하동"}}
        if path == "/ips/solar/potential/data":
            assert params["areas"] == ["31014630"]
            return [{"area": "31014630  ", "thry_ground_genqy": 4715877.06, "thry_rooftop_genqy": 274193.93,
                     "tech_ground_genqy": 137573.76, "mrkt_ground_genqy": 0}]
        if path.endswith("selectSolarPotentialBySigCd_KIER.do"):
            assert params == {"sigCd": "31014"}
            return {"success": True, "data": {"sigcd": "31014", "sigunnm": "수원시 영통구", "thrygenqyground": 28771610}}
        assert params == {"stdgCd": "41117104"}
        if path.endswith("selectSolarSummaryAllByInstallType.do"):
            return {"result": [{"stdgCd": "41117104", "genqy": 6456142.95, "totalArea": 27885.29, "rank": 2}]}
        if path.endswith("selectAnnualForecastByInstallTypeStdgCd.do"):
            return {"result": {"list": [{"stdgCd": "41117104", "instlTypeNm": "공공시설물", "genqy": 617595.91},
                                        {"stdgCd": "41117103", "instlTypeNm": "수상형", "genqy": 99}]}}
        raise AssertionError(path)

    monkeypatch.setattr(solar_regions, "_post", post)
    with TestClient(create_app(LocalRepository(tmp_path / "db.json"), seed=False)) as client:
        query = "?latitude=37.285&longitude=127.06"
        location = client.get("/api/solar-region/location" + query).json()
        assert location["location"] == {"district": "수원시 영통구", "administrative": "광교2동", "legal": "하동"}
        assert len(calls) == 1
        result = client.get("/api/solar-region" + query).json()
        assert len(calls) == 5  # The summary shares the cached region lookup.
        assert result["potential"]["theoretical"] == {"ground_mwh": 4715877.06, "roof_mwh": 274193.93}
        assert result["potential"]["market"] == {"ground_mwh": 0, "roof_mwh": None}
        assert result["district_potential"]["ground_mwh"] == 28771610
        assert result["generation"]["annual_kwh"] == 6456142.95
        assert result["generation"]["rank_area"] == "수원시"
        assert result["generation_mix"] == [{"name": "공공시설물", "annual_kwh": 617595.91}]
        assert client.get("/api/solar-region?latitude=91&longitude=127.06").status_code == 422


def test_missing_statistics_do_not_remove_a_valid_region(monkeypatch):
    monkeypatch.setattr(solar_regions, "_position", lambda *_: {
        "sgg_nm": "수원시 권선구", "hjd2506_cd": "31012410", "hjd2506_nm": "권선1동",
    })
    monkeypatch.setattr(solar_regions, "_boundary_position", lambda *_: ("unmatched", {}))

    def unavailable(*_):
        raise httpx.ConnectError("connection failed")

    monkeypatch.setattr(solar_regions, "_potential", unavailable)
    monkeypatch.setattr(solar_regions, "_district_potential", unavailable)
    result = solar_regions.at(37.25, 127.02)
    assert result["status"] == "available"
    assert result["location"]["administrative"] == "권선1동"
    assert result["potential"] is None
    assert result["generation"] is None
    assert solar_regions.at(35.16, 129.06)["status"] == "outside"


@pytest.mark.parametrize("primary_fails", [False, True])
def test_boundary_lookup_recovers_missing_primary_location(monkeypatch, primary_fails):
    def primary(*_):
        if primary_fails:
            raise httpx.ReadTimeout("upstream timeout")
        return {}

    suwon = box(126.9, 37.2, 127.1, 37.32)
    dong = box(127.01, 37.24, 127.05, 37.29)
    boundaries = {
        "hjd/sigun.json": [("3101", "수원시", suwon)],
        "hjd/20250630/emd-3101.json": [("31013560", "인계동", dong)],
        "bjd/sigun.json": [("4111", "수원시", suwon)],
        "bjd/20260622/emd-4111.json": [("41115141", "인계동", dong)],
    }

    monkeypatch.setattr(solar_regions, "_position", primary)
    monkeypatch.setattr(solar_regions, "_boundaries", lambda path, _day: boundaries[path])
    monkeypatch.setattr(solar_regions, "_potential", lambda code, _: {"code": code})
    monkeypatch.setattr(solar_regions, "_district_potential", lambda *_: None)
    monkeypatch.setattr(solar_regions, "_generation", lambda code, _: {"code": code})
    monkeypatch.setattr(solar_regions, "_generation_mix", lambda *_: [])
    result = solar_regions.at(37.2635, 127.0288)
    assert result["status"] == "available"
    assert result["location"] == {"district": "수원시", "administrative": "인계동", "legal": "인계동"}
    assert result["potential"] == {"code": "31013560"}
    assert result["generation"]["code"] == "41115141"
    assert solar_regions.location_at(37.21, 127.05)["status"] == "unmatched"
    assert solar_regions.location_at(37.321, 127.05)["status"] == "unmatched"
    assert solar_regions.location_at(37.56, 126.98)["status"] == "outside"


def test_empty_lookup_and_failed_boundaries_are_not_reported_as_outside(monkeypatch):
    monkeypatch.setattr(solar_regions, "_position", lambda *_: {})

    def fail(*_):
        raise httpx.ConnectError("connection failed")

    monkeypatch.setattr(solar_regions, "_boundaries", fail)
    assert solar_regions.location_at(37.26, 127.03)["status"] == "unavailable"
