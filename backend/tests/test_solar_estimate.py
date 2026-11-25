import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import kwater
from app.main import create_app
from app.schemas import Equipment
from app.solar_estimate import estimate, potential, reference_plants
from app.store import LocalRepository


@pytest.fixture
def records(monkeypatch):
    plants = [
        {"id": "near", "name": "Near", "type": "plant", "capacity_kw": 100,
         "latitude": 36.8, "longitude": 127., "data_kind": "generation"},
        {"id": "far", "name": "Far", "type": "plant", "capacity_kw": 100,
         "latitude": 35., "longitude": 128., "data_kind": "settlement"},
        {"id": "water", "name": "Water", "type": "floating", "capacity_kw": 100,
         "latitude": 36.8, "longitude": 127., "data_kind": "settlement"},
    ]
    daily = pd.DataFrame([{"plant_id": plant["id"], "date": date, "kwh": kwh, "flag": "ok"}
                          for plant, kwh in zip(plants, (300, 600, 400))
                          for date in pd.date_range("2024-01-01", "2024-12-31")])
    monkeypatch.setattr(kwater, "load_registry", lambda: plants)
    monkeypatch.setattr(kwater, "load_daily", lambda: daily)
    return daily


def test_reference_annualization_uses_all_calendar_months_and_similar_type(records):
    rows = reference_plants(36.8, 127, "building")
    assert [row["id"] for row in rows] == ["near", "far"]
    assert rows[0]["specific_yield"] == pytest.approx(1095)
    assert rows[1]["specific_yield"] == pytest.approx(2190)
    assert [row["id"] for row in reference_plants(36.8, 127, "floating")] == ["water"]


def test_incomplete_months_and_bad_days_do_not_inflate_a_reference(records):
    # Even an extremely large bad reading is never counted as normal output.
    records.loc[(records.plant_id == "near") & (records.date.dt.month == 7), ["flag", "kwh"]] = ["spike", 999999]
    rows = reference_plants(36.8, 127, "land")
    assert [row["id"] for row in rows] == ["far"]
    assert rows[0]["specific_yield"] == pytest.approx(2190)


def test_estimate_respects_saved_capacity_and_nearby_weighting(records):
    equipment = Equipment(capacity_mode="capacity", target_capacity_kw=500).model_dump()
    result = estimate({"latitude": 36.8, "longitude": 127, "site_type": "building", "geometry": None}, equipment)
    assert 1095 < result["specific_yield"] < 1110
    assert result["capacity_dc_kw"] >= 500
    assert result["annual_kwh"] == pytest.approx(result["specific_yield"] * result["capacity_dc_kw"])
    assert result["capacity_basis"] == "저장된 설계 조건"


def test_point_without_boundary_returns_unit_yield_without_inventing_capacity(records):
    result = estimate({"latitude": 36.8, "longitude": 127, "site_type": "floating", "geometry": None})
    assert result["specific_yield"] == pytest.approx(1460)
    assert result["capacity_dc_kw"] is None
    assert result["annual_kwh"] is None


def test_area_estimate_applies_excluded_geometry(records):
    geometry = {"type": "Polygon", "coordinates": [[[127, 36.8], [127.001, 36.8], [127.001, 36.801], [127, 36.801], [127, 36.8]]]}
    candidate = {"latitude": 36.8, "longitude": 127, "site_type": "building", "geometry": geometry}
    normal = estimate(candidate)
    excluded = estimate({**candidate, "exclusions": [geometry]})
    assert normal["annual_kwh"] > 0
    assert excluded["annual_kwh"] == 0
    assert excluded["module_count"] == 0


def test_api_rejects_invalid_location_and_reports_missing_records(records, monkeypatch, tmp_path):
    repo = LocalRepository(tmp_path / "test.sqlite3")
    with TestClient(create_app(repo, seed=False)) as client:
        candidate = {"name": "test", "latitude": 36.8, "longitude": 127., "site_type": "land"}
        response = client.post("/api/solar-estimate", json={"candidate": candidate})
        assert response.status_code == 200
        assert response.json()["status"] == "available"
        assert client.post("/api/solar-estimate", json={"candidate": {**candidate, "latitude": 20.}}).status_code == 422
        assert client.post("/api/solar-estimate", json={"candidate": candidate, "equipment": {"area_use_pct": -10}}).status_code == 422
        monkeypatch.setattr(kwater, "load_daily", lambda: pd.DataFrame())
        assert client.post("/api/solar-estimate", json={"candidate": candidate}).json()["status"] == "unavailable"
    repo.close()


def test_potential_uses_boundary_instead_of_saved_module_count(records):
    candidate = {"latitude": 36.8, "longitude": 127, "site_type": "building", "geometry": {
        "type": "Polygon", "coordinates": [[[127, 36.8], [127.001, 36.8], [127.001, 36.801], [127, 36.801], [127, 36.8]]]}}
    small = Equipment(capacity_mode="count", module_count=10, area_use_pct=65).model_dump()
    large = {**small, "module_count": 20000, "target_capacity_kw": 9999}
    a, b = potential(candidate, small), potential(candidate, large)
    assert a["capacity_dc_kw"] == b["capacity_dc_kw"]
    assert a["annual_kwh"] == b["annual_kwh"]
    assert a["module_count"] > 10
    assert a["usable_area_m2"] > 0
    assert sum(a["monthly_kwh"]) == pytest.approx(a["annual_kwh"])


def test_potential_does_not_treat_a_capacity_target_as_site_area(records):
    candidate = {"latitude": 36.8, "longitude": 127, "site_type": "building", "geometry": None}
    result = potential(candidate, Equipment(capacity_mode="capacity", target_capacity_kw=5000).model_dump())
    assert result["capacity_dc_kw"] is None
    assert result["annual_kwh"] is None
