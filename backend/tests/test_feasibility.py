"""Sizing, geographic weather selection, signed prices and result consistency."""
from copy import deepcopy
import math

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import calibration, kma, weather
from app.engine.analysis import run_analysis
from app.engine.finance import calculate_finance
from app.engine.sizing import preview
from app.main import create_app
from app.schemas import CandidateCreate, Equipment, Finance, defaults
from app.store import LocalRepository


def site():
    return CandidateCreate(name="예비 후보지", latitude=36.76, longitude=127.29, site_type="land").model_dump()


@pytest.mark.parametrize("power", [450., 480., 650.])
def test_target_rounds_up_and_capacity_equals_modules(power):
    equipment = Equipment(module_preset="custom", module_power_w=power, capacity_mode="target",
                          target_capacity_kw=100.).model_dump()
    value = preview(site(), equipment)
    assert value["minimum_modules"] == math.ceil(100000 / power)
    assert value["capacity_kw"] >= 100
    assert value["capacity_kw"] == value["module_count"] * power / 1000
    assert value["module_count"] >= value["minimum_modules"]


def test_area_reserves_walkways_and_row_spacing():
    equipment = Equipment(capacity_mode="area_input", site_area_m2=10000., spacing_mode="manual",
                          row_spacing_m=1., reserve_pct=0.).model_dump()
    plain = preview(site(), equipment)
    reserve = preview(site(), {**equipment, "reserve_pct": 30.})
    spaced = preview(site(), {**equipment, "row_spacing_m": 4.})
    assert reserve["module_count"] < plain["module_count"]
    assert spaced["module_count"] < plain["module_count"]
    assert plain["capacity_kw"] == plain["module_count"] * 450 / 1000
    with pytest.raises(ValueError, match="모듈 수|직렬"):
        preview(site(), {**equipment, "site_area_m2": 1.})


@pytest.mark.parametrize("price", [-100., 0., 1e16])
def test_prices_have_no_bounds_and_drive_cash_inflow(price):
    finance = Finance(fixed_price=price, smp_price=price, rec_price=price).model_dump()
    value = calculate_finance(1000., 100000., {"annual_om": 100.}, finance)
    assert value["first_year_revenue"] == 1000 * price
    assert value["net_profit"] == value["cashflows"][-1]["cumulative"]
    assert value["required_price_per_kwh"] > 0
    if price <= 0:
        assert value["payback_years"] is None


def test_nonfinite_prices_are_rejected():
    with pytest.raises(ValidationError):
        Finance(fixed_price=float("inf"))


def test_station_distance_is_geographic_and_fallback_is_explicit():
    cheonan = kma.nearest_weather(36.76217, 127.29282)
    assert cheonan["nearest"]["stn"] == 232
    assert cheonan["nearest"]["distance_km"] == pytest.approx(0)
    assert cheonan["selected"]["has_observations"]
    incheon = kma.nearest_weather(37.47772, 126.6249)
    assert incheon["nearest"]["stn"] == 112
    assert incheon["selected"]["stn"] != 112
    assert incheon["selected"]["distance_km"] > 0
    assert kma.nearest_weather(35.10468, 129.03203)["selected"]["stn"] == 159


def weather_frame():
    index = pd.date_range("2024-01-01", "2025-01-01", inclusive="left", freq="h", tz="Asia/Seoul")
    daylight = (index.hour >= 10) & (index.hour <= 14)
    frame = pd.DataFrame({"ghi": daylight * 700., "dni": daylight * 600., "dhi": daylight * 100.,
                          "temp_air": 20., "wind_speed": 2.}, index=index)
    frame.attrs.update(interval_minutes=60, source="explicit test data")
    return frame


def test_station_profile_adjusts_solar_and_temperature_without_mutation():
    frame = weather_frame()
    original = frame.copy(deep=True)
    selection = kma.nearest_weather(37.57142, 126.9658)
    adjusted, factors = kma.apply_station_profile(frame, selection)
    pd.testing.assert_frame_equal(frame, original)
    assert len(factors) == 12
    for row in selection["profile"]["months"]:
        subset = adjusted[adjusted.index.month == row["month"]]
        assert subset.ghi.mean() * 24 / 1000 == pytest.approx(row["ghi_kwh_m2_day"])
        assert subset.temp_air.mean() == pytest.approx(row["temp_air"])


def test_complete_analysis_is_consistent_and_uses_saved_station_profile(monkeypatch):
    frame = weather_frame()
    monkeypatch.setattr(weather, "hourly", lambda *args: frame)
    monkeypatch.setattr(kma, "climate_check", lambda *args: None)
    monkeypatch.setattr(calibration, "apply", lambda *args, **kwargs: pytest.fail("Unvalidated station profile must not use old calibration"))
    design = defaults("land")
    design["equipment"].update(capacity_mode="target", target_capacity_kw=100.)
    design["finance"].update(fixed_price=-5., price_scenarios=[-10., 0., 150.])
    selection = kma.nearest_weather(36.76, 127.29)
    snapshot = {"candidate": site(), "design": design, "weather": {"years": [2024], "station_selection": selection}}
    original = deepcopy(snapshot)
    result = run_analysis(snapshot)
    assert snapshot == original
    assert result["capacity_dc_kw"] == result["sizing"]["capacity_kw"]
    assert result["capacity_dc_kw"] >= 100
    assert result["calibration"] is None
    assert sum(row["generation_kwh"] for row in result["revenue_monthly"]) == pytest.approx(result["annual_kwh"])
    assert sum(row["revenue"] for row in result["revenue_monthly"]) == pytest.approx(result["economics"]["first_year_revenue"])
    assert result["economics"]["first_year_revenue"] == pytest.approx(-5 * result["annual_kwh"])
    assert len(result["orientation_comparison"]) == 5
    assert result["orientation_comparison"][0]["annual_kwh"] == pytest.approx(result["physics"]["annual_kwh"])
    assert len(result["weather_station"]["applied_factors"]) == 12
    assert [row["price_per_kwh"] for row in result["price_scenarios"]] == [-10, 0, 150]
    assert all(row["source"] and row["unit"] for row in result["financial_assumptions"])
    assert not {"float", "mooring"} & {row["key"] for row in result["steps"]["costs"]["items"]}


def test_new_api_preview_and_weather_routes(tmp_path):
    repo = LocalRepository(tmp_path / "preview.sqlite3")
    with TestClient(create_app(repo, seed=False)) as client:
        assert len(client.get("/api/weather/stations").json()["stations"]) >= 90
        assert client.get("/api/weather/nearest?latitude=35.10468&longitude=129.03203").json()["selected"]["stn"] == 159
        equipment = Equipment(capacity_mode="target").model_dump()
        response = client.post("/api/analysis/preview", json={"candidate": site(), "equipment": equipment})
        assert response.status_code == 200, response.text
        assert response.json()["capacity_kw"] >= 100
        assert client.get("/api/weather/nearest?latitude=91&longitude=127").status_code == 422
        assert client.post("/api/analysis/preview", json={"candidate": site(), "equipment": {**equipment, "site_area_m2": -1}}).status_code == 422
    repo.close()
