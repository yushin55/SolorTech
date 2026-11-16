"""설치장소·용량 입력 방식·관측소·판매단가 규칙."""
import math

import pytest
from fastapi.testclient import TestClient

from app import stations
from app.engine import guideline
from app.engine.analysis import capacity_plan
from app.engine.finance import calculate_finance
from app.schemas import Equipment, Finance


@pytest.fixture
def client(tmp_path):
    from app.main import create_app
    from app.store import LocalRepository

    repo = LocalRepository(tmp_path / "test.sqlite3")
    with TestClient(create_app(repo, seed=False)) as app_client:
        yield app_client
    repo.close()


def _resolved(**changes):
    equipment = Equipment(**changes).model_dump()
    factors = guideline.site_factors(36.79, 127.0)
    return guideline.resolve_equipment(equipment, factors)


def test_nearest_station_is_found_by_coordinate_distance():
    first = stations.nearest(36.79, 127.0, 3)
    assert first[0]["name"] == "천안" and first[0]["distance_km"] == pytest.approx(26.3, abs=0.5)
    assert first[0]["distance_km"] <= first[1]["distance_km"] <= first[2]["distance_km"]
    seoul = stations.nearest(37.5714, 126.9658)[0]
    assert seoul["stn"] == 108 and seoul["distance_km"] < 0.1
    assert len(stations.STATIONS) == 96


def test_site_area_mode_counts_modules_from_area_minus_reserve():
    equipment, pitch = _resolved(capacity_mode="site_area", site_area_m2=20000, reserve_pct=20,
                                 module_preset="qcells_xl_g11s_590")
    plan = capacity_plan(equipment, pitch)
    expected = math.floor(20000 * .8 / (pitch["pitch_m"] * 1.134))
    assert plan["requested_modules"] == expected
    assert plan["requested_dc_kw"] == pytest.approx(expected * .59)
    assert plan["usable_area_m2"] == pytest.approx(16000)
    assert 0 < plan["ground_coverage_pct"] < 80
    assert equipment["module_manufacturer"] == "한화큐셀(Qcells)" and "데이터시트" in equipment["module_source"]


def test_capacity_mode_rounds_up_to_whole_modules():
    equipment, pitch = _resolved(capacity_mode="capacity", target_capacity_kw=1000, module_preset="floating_450")
    plan = capacity_plan(equipment, pitch)
    assert plan["requested_modules"] == 2223 and plan["requested_dc_kw"] == pytest.approx(1000.35)


def test_tiny_area_is_rejected_with_a_reason():
    equipment, pitch = _resolved(capacity_mode="site_area", site_area_m2=3, reserve_pct=50)
    with pytest.raises(ValueError, match="1장도"):
        capacity_plan(equipment, pitch)


def test_user_sale_price_has_no_bounds():
    assert Finance(fixed_price=-20).fixed_price == -20
    assert Finance(fixed_price=1e6).fixed_price == 1e6
    result = calculate_finance(1_000_000, 1e9, {"annual_om": 0}, {"fixed_price": 300, "years": 20}, "sale")
    assert result["total_revenue"] == pytest.approx(sum(row["revenue"] for row in result["cashflows"]))
    assert result["net_profit"] == pytest.approx(result["cashflows"][-1]["cumulative"])


def test_building_site_type_is_accepted():
    from app.schemas import CandidateCreate

    candidate = CandidateCreate(name="옥상", latitude=36.5, longitude=127.3, site_type="building")
    assert candidate.site_type == "building"


def test_station_and_capacity_preview_endpoints(client):
    listing = client.get("/api/weather-stations").json()
    assert len(listing["stations"]) == 96 and "minwon.kma.go.kr" in listing["source"]
    site = client.get("/api/guideline/site", params={"latitude": 36.79, "longitude": 127.0}).json()
    assert site["weather_station"]["name"] == "천안" and len(site["nearby_stations"]) == 3
    preview = client.post("/api/capacity-preview", json={
        "latitude": 36.79, "longitude": 127.0,
        "equipment": {"capacity_mode": "capacity", "target_capacity_kw": 500, "module_preset": "hdhes_t440nf"}})
    assert preview.status_code == 200
    body = preview.json()
    assert body["requested_modules"] == math.ceil(500000 / 440) and body["module"]["module_power_w"] == 440
    bad = client.post("/api/capacity-preview", json={"latitude": 36.79, "longitude": 127.0,
                                                      "equipment": {"site_area_m2": -1}})
    assert bad.status_code == 422 and "site_area_m2" in bad.json()["detail"]


def test_nearest_pyranometer_correction_by_coordinate(monkeypatch):
    from app import calibration, kma

    seoul = {"station": kma.station(108), "factors": {1: 1.1, 7: .9}}
    daegu = {"station": kma.station(143), "factors": {1: 1.0, 7: .8}}
    near = kma.nearest_correction(35.87, 128.6, {108: seoul, 143: daegu})
    assert near["name"] == "대구" and near["distance_km"] < 10 and near["factors"][7] == .8
    assert kma.nearest_correction(33.5, 126.5, {108: seoul, 143: daegu}) is None   # 제주: 100 km 밖

    stored = {"weather_correction": {
        "applied": True, "mode": "nearest", "factors": {"1": 1.1}, "check": {"station": kma.station(108)},
        "station_factors": {"108": {"station": kma.station(108), "factors": {"1": 1.1}},
                            "143": {"station": kma.station(143), "factors": {"1": 1.0}}}}}
    monkeypatch.setattr(calibration, "load_result", lambda: stored)
    factors, info = calibration.irradiance_correction(35.87, 128.6)
    assert info["mode"] == "nearest" and info["name"] == "대구" and factors == {1: 1.0}
    factors, info = calibration.irradiance_correction(33.5, 126.5)   # 가까운 일사계 없음 → 공통 계수
    assert info["mode"] == "global" and factors == {1: 1.1}
    stored["weather_correction"]["applied"] = False
    assert calibration.irradiance_correction(35.87, 128.6) == (None, None)


def test_kwater_plants_use_verified_site_coordinates():
    from app import kwater

    rows = {row[0]: row for row in kwater._SETTLEMENT_PLANTS}
    assert len(rows) == 26
    assert all(row[5].startswith("현장 주소 지도 확인") for row in rows.values())
    chungju = rows["chungju-floating"]
    assert stations.nearest(chungju[3], chungju[4])[0]["name"] == "충주"


def test_fetch_data_unpacks_github_tarball_and_blocks_escapes(tmp_path):
    import io
    import sys
    import tarfile

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "scripts"))
    import fetch_data

    def tarball(entries):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, data in entries:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return buffer.getvalue()

    count = fetch_data.extract(tarball([("owner-SolorTech-data-1a2b/아산 태양광 발전량/월간보고서_202304.xls", b"x"),
                                        ("owner-SolorTech-data-1a2b/README.md", b"y")]), tmp_path / "raw")
    assert count == 2 and (tmp_path / "raw" / "아산 태양광 발전량" / "월간보고서_202304.xls").read_bytes() == b"x"
    with pytest.raises(ValueError):
        fetch_data.extract(tarball([("top/../../escape.txt", b"z")]), tmp_path / "other")
