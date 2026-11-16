"""Terrain-specific behavior with explicit test weather, never network downloads."""
from copy import deepcopy

import pandas as pd
import pytest
from pydantic import ValidationError
from shapely.geometry import box, mapping
from shapely.ops import transform

from app import calibration, kma, weather
from app.engine import calculate_energy, calculate_layout, run_analysis
from app.engine.geometry import projection_for
from app.engine.siting import resolve
from app.engine import guideline
from app.schemas import CandidateCreate, defaults


@pytest.fixture
def site():
    candidate = CandidateCreate(name="육상 검토", latitude=36.5, longitude=127., site_type="land",
                                cable_distance_m=25., terrain_slope_deg=8.).model_dump()
    _, inverse = projection_for(candidate)
    candidate["geometry"] = mapping(transform(inverse.transform, box(-40, -40, 40, 40)))
    return candidate


@pytest.fixture
def test_weather(monkeypatch):
    timestamps = pd.date_range("2024-01-01", "2025-01-01", inclusive="left", freq="h", tz="Asia/Seoul")
    daylight = (timestamps.hour >= 10) & (timestamps.hour <= 14)
    frame = pd.DataFrame({"ghi": daylight * 900., "dni": daylight * 800., "dhi": daylight * 150.,
                          "temp_air": 25., "wind_speed": 2.}, index=timestamps)
    frame.attrs.update(interval_minutes=60, source="explicit unit-test weather")
    monkeypatch.setattr(weather, "hourly", lambda *args: frame)
    monkeypatch.setattr(calibration, "irradiance_factors", lambda: None)
    monkeypatch.setattr(kma, "climate_check", lambda *args: None)
    def no_floating_calibration(*args, **kwargs):
        raise AssertionError("Land/building must not apply the floating-selected calibration")
    monkeypatch.setattr(calibration, "apply", no_floating_calibration)
    return frame


def analyse(site):
    design = defaults(site["site_type"])
    design["equipment"].update(capacity_mode="count", module_count=100)
    return run_analysis({"candidate": site, "design": design, "weather": {"years": [2024]}})


def test_setback_changes_area_and_never_changes_floating_layout(site):
    equipment = {"module_count": 100, "module_width_m": 1.043, "module_height_m": 2.275, "row_spacing_m": 1.}
    base = calculate_layout(site, equipment)
    inset = calculate_layout({**site, "boundary_setback_m": 10.}, equipment)
    assert inset["usable_area_m2"] == pytest.approx(3600, rel=.001)
    assert inset["usable_area_m2"] < base["usable_area_m2"]
    floating = calculate_layout({**site, "site_type": "floating", "boundary_setback_m": 10.}, equipment)
    assert floating["usable_area_m2"] == pytest.approx(base["usable_area_m2"])


def test_land_costs_energy_and_snapshot_are_independent(site, test_weather):
    original = deepcopy(site)
    result = analyse(site)
    assert site == original
    assert result["energy_basis"] == "physics"
    assert result["calibration"] is None
    assert result["annual_kwh"] > 0
    assert not {"float", "mooring"} & {row["key"] for row in result["steps"]["costs"]["items"]}
    assert "structure" in {row["key"] for row in result["steps"]["costs"]["items"]}
    assert not any("수심" in warning for warning in result["provenance"]["warnings"])
    shaded = analyse({**site, "shading_loss_pct": 20.})
    # The 20% loss applies to DC; inverter part-load efficiency makes AC nonlinear.
    assert shaded["annual_kwh"] == pytest.approx(result["annual_kwh"] * .8, rel=.02)


def test_roof_mount_uses_roof_orientation_and_hotter_cells(site, test_weather):
    roof = {**site, "site_type": "rooftop", "roof_mount": "flush", "roof_tilt_deg": 20., "roof_azimuth_deg": 90.}
    equipment, pitch, _, warnings = resolve(roof, defaults("rooftop")["equipment"], guideline.site_factors(36.5, 127.))
    assert (equipment["tilt"], equipment["azimuth"]) == (20, 90)
    assert pitch["gap_m"] == 0
    assert any("추가하중" in warning for warning in warnings)
    equipment.update(module_count=100, ac_capacity_kw=100.)
    close = calculate_energy(equipment, 36.5, 127., test_weather)["annual_kwh"]
    open_rack = calculate_energy({**equipment, "temperature_model": "open_rack_glass_glass"}, 36.5, 127., test_weather)["annual_kwh"]
    assert close < open_rack
    result = analyse(roof)
    assert result["steps"]["site"]["azimuth"] == 90
    assert result["calibration"] is None


def test_slope_and_roof_overload_are_reported(site, test_weather):
    steep = analyse({**site, "terrain_slope_deg": 20., "slope_limit_deg": 15.})
    assert any("경사 20°" in w and "초과" in w for w in steep["provenance"]["warnings"])
    roof = analyse({**site, "site_type": "rooftop", "roof_allowable_load_kg_m2": 15., "roof_system_load_kg_m2": 25.})
    assert any("추가하중 25" in w and "초과" in w for w in roof["provenance"]["warnings"])


def test_impossible_setback_is_rejected(site, test_weather):
    with pytest.raises(ValueError, match="배치 가능한 모듈"):
        analyse({**site, "boundary_setback_m": 50.})


def test_land_capacity_uses_placed_quantity(site, test_weather):
    design = defaults("land")
    design["equipment"].update(capacity_mode="count", module_count=10000)
    result = run_analysis({"candidate": site, "design": design, "weather": {"years": [2024]}})
    assert result["steps"]["equipment"]["module_count"] < 10000
    assert result["layout"]["module_count"] == result["steps"]["equipment"]["module_count"]
    assert any("실제 배치" in w for w in result["provenance"]["warnings"])


@pytest.mark.parametrize("field,value", [("boundary_setback_m", -1.), ("shading_loss_pct", 100.),
    ("terrain_slope_deg", 90.), ("roof_allowable_load_kg_m2", -1.), ("roof_azimuth_deg", 361.)])
def test_invalid_terrain_inputs_are_rejected(site, field, value):
    with pytest.raises(ValidationError):
        CandidateCreate.model_validate({**site, field: value})
