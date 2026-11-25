import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import kwater, solartech
from app.main import create_app
from app.solar_status import status
from app.store import LocalRepository


@pytest.fixture
def operating(monkeypatch):
    plants = [{"id": "existing", "name": "Existing", "latitude": 36.8, "longitude": 127.,
               "capacity_kw": 2132.1, "data_kind": "settlement"}]
    records = pd.DataFrame([
        {"plant_id": "existing", "date": pd.Timestamp("2026-01-01"), "kwh": 10., "flag": "ok"},
        {"plant_id": "existing", "date": pd.Timestamp("2026-01-02"), "kwh": 0., "flag": "zero"},
        {"plant_id": "existing", "date": pd.Timestamp("2026-01-03"), "kwh": 99999., "flag": "spike"},
    ])
    monkeypatch.setattr(kwater, "load_registry", lambda: plants)
    monkeypatch.setattr(kwater, "load_daily", lambda: records)
    monkeypatch.setattr(solartech, "load_registry", lambda: {"assets": []})
    return {"name": "candidate", "latitude": 36.8, "longitude": 127., "site_type": "building", "reference_plant_id": "existing"}


def test_actual_status_preserves_zero_days_partial_years_and_settlement_identity(operating):
    result = status(operating)
    facility = result["facilities"][0]
    assert result["scope"] == "linked"
    assert facility["capacity_kw"] == 2132.1
    series = facility["series"][0]
    assert series["label"] == "전력거래량"
    year = series["years"][0]
    assert year["recorded_kwh"] == 10  # Not 365-day annualized; spike is excluded.
    assert year["observed_periods"] == 2  # Zero output is an observed day.
    assert year["complete"] is False
    assert year["end"] == "2026-01-02"
    assert year["monthly_kwh"] == [10, *([None] * 11)]
    assert "annual_kwh" not in result


def test_an_unlinked_boundary_does_not_inherit_nearby_or_reference_generation(operating):
    candidate = {**operating, "reference_plant_id": None, "geometry": {"type": "Polygon", "coordinates": [
        [[127.01, 36.8], [127.02, 36.8], [127.02, 36.81], [127.01, 36.81], [127.01, 36.8]]]}}
    assert status(candidate)["facilities"] == []
    assert status({**candidate, "geometry": None})["scope"] == "nearby"
    assert len(status({**candidate, "geometry": None})["facilities"]) == 1


def test_asset_specs_do_not_create_generation_observations(operating, monkeypatch):
    monkeypatch.setattr(solartech, "load_registry", lambda: {"source_file": "assets.xlsx", "assets": [
        {"id": "asset", "name": "Installed roof", "capacity_kw": 42.}], "generation_catalog": {"series": [
            {"id": "ambiguous", "asset_ids": ["asset", "another"]}]}})
    result = status({**operating, "reference_plant_id": None, "solartech_asset_id": "asset"})
    assert len(result["facilities"]) == 1
    assert result["facilities"][0]["capacity_kw"] == 42
    assert result["facilities"][0]["series"] == []


def test_status_api_is_independent_of_proposed_design_capacity(operating, tmp_path):
    repo = LocalRepository(tmp_path / "test.sqlite3")
    with TestClient(create_app(repo, seed=False)) as client:
        response = client.post("/api/solar-status", json={"candidate": operating, "equipment": {"target_capacity_kw": 99999.}})
        assert response.status_code == 200
        assert response.json()["facilities"][0]["capacity_kw"] == 2132.1
        assert client.post("/api/solar-status", json={"candidate": {**operating, "latitude": 20.}}).status_code == 422
    repo.close()
