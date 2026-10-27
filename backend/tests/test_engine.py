"""Unit checks for physical units, guideline rules, geometry and discounted cash flow."""

from copy import deepcopy

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

from app import weather
from app.engine import calculate_energy, calculate_finance, calculate_layout, run_analysis
from app.engine import guideline
from app.engine.energy import _monthly_integrals
from app.engine.finance import _irr
from app.engine.geometry import projection_for

ASAN = (36.79, 127.0)


@pytest.fixture
def equipment():
    return {"module_model": "test", "module_count": 10, "module_power_w": 500,
            "module_width_m": 1.1, "module_height_m": 2.2,
            "ac_capacity_kw": 4.5, "inverter_efficiency": .975,
            "gamma_pdc": -.0035, "tilt": 15, "azimuth": 180,
            "row_spacing_m": 1, "system_loss_pct": 14}


@pytest.fixture
def candidate():
    value = {"latitude": ASAN[0], "longitude": ASAN[1], "name": "검증 후보지",
             "exclusions": [], "grid_point": None, "cable_distance_m": 20, "site_type": "floating"}
    _, inverse = projection_for(value)
    value["geometry"] = mapping(transform(inverse.transform, box(-60, -60, 60, 60)))
    return value


@pytest.fixture
def cached_year():
    """One real ERA5 year from the committed cache; skip rather than download."""
    path = weather._path(*weather.grid_point(*ASAN), 2024)
    if not path.exists():
        pytest.skip("ERA5 캐시(2024, 아산 격자)가 없습니다.")
    return [2024]


def _weather(times, minutes=30):
    """Explicit constant-irradiance unit-test input (not application data)."""
    return {"source": "unit-test", "interval_minutes": minutes,
            "data": [{"timestamp": time, "ghi": 900, "dni": 800, "dhi": 150,
                      "temp_air": 25, "wind_speed": 2} for time in times]}


def test_half_hour_integrates_kw_into_kwh_and_clips(equipment):
    equipment["ac_capacity_kw"] = .1
    times = pd.date_range("2025-06-15 12:00", periods=4, freq="30min", tz="Asia/Seoul")
    result = calculate_energy(equipment, 36.5, 127, _weather(times))
    assert result["annual_kwh"] == pytest.approx(.1 * 2)
    assert [row["energy_kwh"] for row in result["hourly"]] == pytest.approx([.05] * 4)
    assert result["monthly"][5]["energy_kwh"] == pytest.approx(.2)


def test_weather_is_required(equipment):
    with pytest.raises(ValueError, match="기상자료"):
        calculate_energy(equipment, 36.5, 127, None)


def test_capacity_scaling_and_orientation_are_physical(equipment):
    weather_rows = _weather(["2025-01-15T12:00:00+09:00"])
    baseline = calculate_energy(equipment, 36.5, 127, weather_rows)["annual_kwh"]
    doubled = {**equipment, "module_count": 20, "ac_capacity_kw": 9}
    assert calculate_energy(doubled, 36.5, 127, weather_rows)["annual_kwh"] == pytest.approx(2 * baseline)
    north = {**equipment, "azimuth": 0, "tilt": 60}
    assert calculate_energy(north, 36.5, 127, weather_rows)["annual_kwh"] < baseline


def test_month_crossing_integrals_split_exactly():
    result = _monthly_integrals(pd.DatetimeIndex(["2025-01-31 23:30"], tz="Asia/Seoul"), [2], [2])
    assert result[0]["energy_kwh"] == 1
    assert result[1]["energy_kwh"] == 3
    assert sum(row["energy_kwh"] for row in result) == 4


def test_night_is_zero_even_with_positive_weather(equipment):
    result = calculate_energy(equipment, 36.5, 127, _weather(["2025-06-15T01:00:00+09:00"]))
    assert result["annual_kwh"] == 0


@pytest.mark.parametrize("field,value", [("ghi", -1), ("dni", float("nan")), ("wind_speed", -1), ("temp_air", 100)])
def test_invalid_weather_is_rejected(equipment, field, value):
    weather_rows = _weather(["2025-06-15T12:00:00+09:00"])
    weather_rows["data"][0][field] = value
    with pytest.raises(ValueError):
        calculate_energy(equipment, 36.5, 127, weather_rows)


def test_irregular_intervals_preserve_gaps_and_end_convention(equipment):
    equipment["ac_capacity_kw"] = .1
    weather_rows = _weather(["2025-06-15T12:30:00+09:00", "2025-06-15T14:00:00+09:00"])
    weather_rows["time_convention"] = "end"
    weather_rows["data"][0]["interval_minutes"] = 30
    weather_rows["data"][1]["interval_minutes"] = 60
    result = calculate_energy(equipment, 36.5, 127, weather_rows)
    assert result["annual_kwh"] == pytest.approx(.15)
    assert result["hourly"][0]["timestamp"] == "2025-06-15T12:00:00+09:00"
    assert any("시간 공백" in warning for warning in result["provenance"]["warnings"])


def test_cached_era5_year_is_interval_start_and_complete(cached_year):
    frame = weather.hourly(*ASAN, cached_year)
    assert list(frame.columns) == ["ghi", "dni", "dhi", "temp_air", "wind_speed"]
    # Open-Meteo stamps interval ends; the first interval starts one hour earlier.
    assert frame.index[0] == pd.Timestamp("2023-12-31 23:00", tz="Asia/Seoul")
    assert len(frame) == 8784
    assert frame.ghi.max() < 1200 and frame.ghi.min() >= 0


# ---------------------------------------------------------------- guideline


def test_string_design_reproduces_table_3_13():
    result = guideline.string_design(4440, {})
    assert (result["series_min"], result["series_max"], result["series"]) == (14, 16, 15)
    assert result["cold_vmp_v"] == pytest.approx(51.46, abs=.01)
    assert result["hot_voc_v"] == pytest.approx(47.09, abs=.01)
    assert result["parallel"] == 296 and result["modules_used"] == 4440


@pytest.mark.parametrize("dc_kw,units", [
    (250, {100: 3}), (350, {500: 1}), (450, {500: 1}), (550, {500: 1, 100: 1}),
    (650, {500: 1, 100: 2}), (750, {500: 2}), (950, {500: 2})])
def test_inverter_selection_reproduces_table_3_12(dc_kw, units):
    result = guideline.inverter_design(dc_kw)
    assert {unit["kw"]: unit["count"] for unit in result["units"]} == units


def test_array_pitch_reproduces_table_3_23():
    assert guideline.array_pitch(2.275, 1, 30)["pitch_m"] == pytest.approx(4.65, abs=.01)
    assert guideline.array_pitch(2.275, 1, 28)["pitch_m"] == pytest.approx(4.53, abs=.01)


def test_energy_substitution_reproduces_appendix_example():
    result = guideline.energy_substitution(1478561.21)
    assert result["households"] == pytest.approx(340.07, rel=1e-3)
    assert result["oil_toe"] == pytest.approx(369.64, rel=1e-3)
    assert result["pine_trees"] == pytest.approx(104460.35, rel=1e-3)
    assert result["co2_t"] == pytest.approx(694.92, rel=1e-3)


def test_site_factors_and_grid_connection():
    asan = guideline.site_factors(*ASAN)
    assert asan["optimal_tilt"] == 30 and "표 3-19" in asan["tilt_basis"]
    assert asan["seasonal_tilts"] == {"spring": 27, "summer": 10, "autumn": 27, "winter": 33}
    assert guideline.site_factors(33.4, 126.5)["optimal_tilt"] == 24
    assert guideline.grid_connection(400, "sale")["network"] == "한전 배전선로"
    assert "22.9" in guideline.grid_connection(1080, "sale")["voltage"]
    assert "380" in guideline.grid_connection(300, "self")["voltage"]


# ---------------------------------------------------------------- finance


def test_finance_exact_discounted_costs_and_required_price():
    result = calculate_finance(100, 1000, {"annual_om": 100, "replacement_cost": 0},
                               {"years": 2, "discount_pct": 10, "degradation_pct": 0,
                                "sale_mode": "fixed", "fixed_price": 10})
    expected_benefits = 1000 / 1.1 + 1000 / 1.1 ** 2
    expected_costs = 1000 + 100 / 1.1 + 100 / 1.1 ** 2
    assert result["pv_inflow"] == pytest.approx(expected_benefits)
    assert result["pv_outflow"] == pytest.approx(expected_costs)
    assert result["npv"] == pytest.approx(sum(row["discounted_net"] for row in result["cashflows"]))
    assert result["bc"] == pytest.approx(expected_benefits / expected_costs)
    assert result["payback_years"] == pytest.approx(1000 / 900)
    assert result["irr_pct"] == pytest.approx((np.roots([1000, -900, -900])[0] - 1) * 100)
    at_required = calculate_finance(100, 1000, {"annual_om": 100}, {
        "years": 2, "discount_pct": 10, "degradation_pct": 0, "sale_mode": "fixed",
        "fixed_price": result["required_price_per_kwh"]})
    assert at_required["bc"] == pytest.approx(1)


def test_rec_curtailment_replacement_and_self_consumption():
    result = calculate_finance(100, 0, {"annual_om": 0, "replacement_cost": 500, "replacement_year": 2},
                               {"years": 2, "discount_pct": 0, "degradation_pct": 1, "curtailment_pct": 10,
                                "sale_mode": "smp_rec", "smp_price": 100, "rec_price": 100000, "rec_weight": 1.5})
    assert result["effective_price_per_kwh"] == 250
    assert result["first_year_sales_kwh"] == 90
    assert result["first_year_revenue"] == 22500
    assert result["cashflows"][2]["generation_kwh"] == 99
    assert result["cashflows"][2]["replacement"] == 500
    own = calculate_finance(100, 0, {}, {"years": 1, "fixed_price": 100, "self_use_kwh": 60, "retail_price": 150}, "self")
    assert own["first_year_self_use_kwh"] == 60
    assert own["first_year_revenue"] == 60 * 150 + 40 * 100


def test_irr_none_for_no_root_and_multiple_roots():
    assert _irr([-100, -10, -10]) is None
    assert _irr([-100, 230, -132]) is None  # Distinct valid rates 10% and 20%.
    assert _irr([-100, 110]) == pytest.approx(10)


# ---------------------------------------------------------------- geometry


def test_geometry_boundary_exclusion_and_interiors_do_not_overlap(candidate, equipment):
    forward, inverse = projection_for(candidate)
    exclusion = box(-5, -5, 5, 5)
    candidate["exclusions"] = [mapping(transform(inverse.transform, exclusion))]
    equipment["module_count"] = 100
    equipment["azimuth"] = 137
    result = calculate_layout(candidate, equipment)
    boundary = transform(forward.transform, shape(candidate["geometry"]))
    modules = [transform(forward.transform, shape(value)) for value in result["modules"]]
    assert result["module_count"] == 100
    assert result["usable_area_m2"] == pytest.approx(result["area_m2"] - 100, abs=.01)
    for index, module in enumerate(modules):
        assert boundary.buffer(1e-7).covers(module)
        assert module.intersection(exclusion).area < 1e-7
        assert all(module.intersection(previous).area < 1e-7 for previous in modules[:index])


def test_small_array_on_large_area_is_a_compact_block(candidate, equipment):
    _, inverse = projection_for(candidate)
    candidate["geometry"] = mapping(transform(inverse.transform, box(-3000, -3000, 3000, 3000)))
    equipment["module_count"] = 400
    result = calculate_layout(candidate, equipment)
    assert result["module_count"] == 400
    assert not any("탐색 한도" in warning for warning in result["warnings"])


def test_layout_shortfall_and_invalid_self_crossing(candidate, equipment):
    candidate["exclusions"] = [candidate["geometry"]]
    result = calculate_layout(candidate, equipment)
    assert result["module_count"] == 0
    assert any("10개 중 0개" in warning for warning in result["warnings"])
    candidate["geometry"] = {"type": "Polygon", "coordinates": [[[127, 36], [127.01, 36.01], [127, 36.01], [127.01, 36], [127, 36]]]}
    with pytest.raises(ValueError, match="유효한 Polygon"):
        calculate_layout(candidate, equipment)


# ---------------------------------------------------------------- full review


def test_six_step_review_on_real_weather(candidate, cached_year):
    from app.schemas import Costs, Equipment, Finance

    design = {"equipment": {**Equipment().model_dump(), "module_count": 240},
              "costs": Costs().model_dump(), "finance": Finance().model_dump()}
    snapshot = {"candidate": candidate, "design": design, "weather": {"years": cached_year}}
    original = deepcopy(snapshot)
    result = run_analysis(snapshot)
    assert snapshot == original
    steps = result["steps"]
    assert steps["site"]["tilt"] == 30
    assert steps["equipment"]["strings"]["series"] == 15
    assert result["capacity_dc_kw"] == pytest.approx(240 * .45)
    assert steps["equipment"]["inverter"]["units"] == [{"kw": 100, "count": 2, "unit_cost": 15e6}]
    assert steps["costs"]["total"] == pytest.approx(sum(item["amount"] for item in steps["costs"]["items"]))
    assert len(result["monthly"]) == 12
    assert result["annual_kwh"] == pytest.approx(sum(row["energy_kwh"] for row in result["monthly"]))
    assert 800 < result["specific_yield"] < 1700
    economics = result["economics"]
    assert economics["bc"] == pytest.approx(economics["pv_inflow"] / economics["pv_outflow"])
    assert [case["label"] for case in result["stress"]][-2:] == ["발전량 −5%", "발전량 −10%"]
    assert result["stress"][-1]["bc"] < economics["bc"]
    assert result["layout"]["module_count"] == 240
    assert result["cable_distance_m"] == 20
