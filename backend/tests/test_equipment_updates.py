"""User-supplied equipment must preserve missing specs and explicit assumptions."""
from copy import deepcopy

import pandas as pd
import pytest

from app import calibration, kma, weather
from app.engine import catalog, guideline
from app.engine.analysis import _apply_quotes, period_model_rows, run_analysis
from app.schemas import CandidateCreate, Equipment, defaults
from app.legacy_data import readable


@pytest.mark.parametrize("model,power,width,height,price,gamma", [
    ("senergy_sl85_66hdx_730u", 730, 1.303, 2.384, 365000, -.0024),
    ("ls_pvm_s350f4b", 350, .996, 1.972, 175000, None),
    ("lg_lg340s2w_w4", 340, 1., 1.960, 170000, -.0042),
])
def test_partial_modules_apply_known_values_without_inventing_missing_specs(model, power, width, height, price, gamma):
    inputs = Equipment(module_preset=model, gamma_pdc=-.0036, vmp_v=39, voc_v=48,
                       voltage_temp_coeff_pct=-.30).model_dump()
    original = deepcopy(inputs)
    resolved, _ = guideline.resolve_equipment(inputs, guideline.site_factors(36.5, 127))
    assert (resolved["module_power_w"], resolved["module_width_m"], resolved["module_height_m"],
            resolved["module_price"]) == (power, width, height, price)
    assert resolved["gamma_pdc"] == (gamma if gamma is not None else -.0036)
    assert (resolved["vmp_v"], resolved["voc_v"], resolved["voltage_temp_coeff_pct"]) == (39, 48, -.30)
    assert "미제공" in resolved["electrical_source"]
    assert ("gamma_pdc" in catalog.MODULES[model]["missing_electrical"]) == (gamma is None)
    inverter = guideline.inverter_design(100, model_id="dass_dsp_33125kshk_nj1")
    _apply_quotes(resolved, {}, inverter)
    assert f"{price:,}" in resolved["module_price_source"]
    _apply_quotes(resolved, {"module_unit_price": 123456}, inverter)
    assert resolved["module_price"] == 123456 and resolved["module_price_source"] == "사용자 견적"
    assert inputs == original


def test_nj1_efficiency_and_external_combiner_are_not_string_inverter_assumptions():
    inputs = Equipment(inverter_model="dass_dsp_33125kshk_nj1", inverter_efficiency=.953).model_dump()
    resolved, _ = guideline.resolve_equipment(inputs, guideline.site_factors(36.5, 127))
    assert resolved["inverter_efficiency"] == .953
    spec = catalog.INVERTERS[inputs["inverter_model"]]
    assert spec["euro_efficiency_pct"] is None and spec["certified_efficiency_pct"] == 97.61
    assert spec["max_pv_capacity_kwp"] is None
    inverter = guideline.inverter_design(126, model_id=inputs["inverter_model"], parallel=30)
    assert inverter["ac_capacity_kw"] == 250 and inverter["unit_count"] == 2
    assert inverter["cost"] == 2 * 125 * 150000
    assert inverter["requires_combiner"] and inverter["junction_box_count"] == 0
    assert any("외부 접속반" in warning for warning in inverter["warnings"])
    assert not any("직렬군 30개 >" in warning for warning in inverter["warnings"])


def test_nj1_string_voltage_uses_model_limits_instead_of_guideline_example():
    inputs = Equipment(module_preset="qcells_xl_g11s_590", inverter_model="dass_dsp_33125kshk_nj1").model_dump()
    resolved, _ = guideline.resolve_equipment(inputs, guideline.site_factors(36.5, 127))
    strings = guideline.string_design(2400, resolved)
    assert strings["cold_vmp_v"] * strings["series_max"] <= 800
    assert strings["cold_voc_v"] * strings["series_max"] <= 1000
    assert strings["hot_vmp_v"] * strings["series_min"] >= 395
    assert "395~800 V" in strings["basis"]
    assert strings["series"] != guideline.string_design(2400, {**resolved, "inverter_model": "guideline"})["series"]


def test_preserved_local_data_can_be_read_without_rewriting_original_records():
    candidate = {"site_type": "rooftop", "shading_loss_pct": 0, "name": "보존 후보"}
    original_candidate = deepcopy(candidate)
    assert readable("candidates", candidate)["site_type"] == "building"
    assert candidate == original_candidate
    data = {**defaults(), "id": "old", "name": "보존 설계"}
    data["equipment"].update(module_preset="hd_his_t650uj", capacity_mode="target", float_model="기록 보존")
    data["finance"]["price_source"] = "예전 입력"
    original = deepcopy(data)
    current = readable("designs", data)
    equipment = Equipment.model_validate(current["equipment"])
    assert equipment.module_preset == "custom" and equipment.module_power_w == 650
    assert equipment.capacity_mode == "capacity"
    assert "float_model" not in current["equipment"] and "price_source" not in current["finance"]
    assert data == original


@pytest.mark.parametrize("module", ["senergy_sl85_66hdx_730u", "ls_pvm_s350f4b", "lg_lg340s2w_w4"])
def test_new_equipment_analysis_and_actual_period_comparison_use_same_assumptions(monkeypatch, module):
    index = pd.date_range("2024-01-01", "2025-01-01", inclusive="left", freq="h", tz="Asia/Seoul")
    daylight = (index.hour >= 10) & (index.hour <= 14)
    frame = pd.DataFrame({"ghi": daylight * 700., "dni": daylight * 600., "dhi": daylight * 100.,
                          "temp_air": 30., "wind_speed": 2.}, index=index)
    frame.attrs.update(interval_minutes=60, source="explicit test weather")
    monkeypatch.setattr(weather, "hourly", lambda *args: frame)
    monkeypatch.setattr(calibration, "irradiance_factors", lambda *args: None)
    monkeypatch.setattr(kma, "climate_check", lambda *args: None)
    monkeypatch.setattr(calibration, "irradiance_correction", lambda *args: (None, {}))
    monkeypatch.setattr(calibration, "apply", lambda *args, **kwargs: None)
    design = defaults("land")
    design["equipment"].update(module_preset=module, inverter_model="dass_dsp_33125kshk_nj1",
                               inverter_efficiency=.953, capacity_mode="capacity", target_capacity_kw=100)
    candidate = CandidateCreate(name="새 장비 검토", latitude=36.5, longitude=127, site_type="land").model_dump()
    snapshot = {"candidate": candidate, "design": design, "weather": {"years": [2024]}}
    original = deepcopy(snapshot)
    result = run_analysis(snapshot)
    assert result["annual_kwh"] > 0 and result["capacity_dc_kw"] >= 100
    equipment = result["steps"]["equipment"]
    assert equipment["inverter_efficiency"] == .953
    assert set(equipment["electrical_assumptions"]) == set(catalog.MODULES[module]["missing_electrical"])
    assert any("95.3%" in assumption for assumption in result["provenance"]["assumptions"])
    assert any("미제공" in warning for warning in result["provenance"]["warnings"])
    module_cost = next(item for item in result["steps"]["costs"]["items"] if item["key"] == "module")
    assert module_cost["amount"] == equipment["module_count"] * catalog.MODULES[module]["module_price"]
    assert "사용자 제공 표" in module_cost["source"]
    comparison = period_model_rows({"snapshot": snapshot, "result": result}, [2024])
    assert sum(row["energy_kwh"] for row in comparison) == pytest.approx(result["physics"]["annual_kwh"])
    assert snapshot == original
