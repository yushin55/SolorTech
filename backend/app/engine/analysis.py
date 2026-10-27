"""Six-step review following the guideline tool (부록 2.1), on real records.

① 설치대상지 선정 → ② 부지면적·기자재 → ③ 설치용량·연간발전량 → ④ 개략공사비
→ ⑤ 예상수익 → ⑥ 재무성 분석·에너지 대체효과. Step ③ runs pvlib on multi-year
reanalysis weather and, when a calibration exists, corrects it with the model
validated on K-water operating records.
"""

import math

from .. import calibration, kma, weather
from . import guideline
from .common import ENGINE_VERSION, integer, number
from .energy import long_term_energy
from .finance import calculate_finance
from .geometry import calculate_layout, connection_distance


def _layout(candidate, equipment, pitch):
    """Area, guideline maximum and conceptual placement of array units."""
    rows = integer(equipment, "array_rows", default=1, minimum=1, maximum=6)
    width = number(equipment, "module_width_m", minimum=.05, maximum=10)
    if candidate.get("geometry") is None:
        return None, None
    probe = calculate_layout(candidate, {"module_count": 0, "module_width_m": width,
                                         "module_height_m": pitch["plan_depth_m"],
                                         "row_spacing_m": pitch["gap_m"], "azimuth": equipment["azimuth"]})
    maximum = math.floor(probe["usable_area_m2"] / (pitch["pitch_m"] * width)) * rows
    return probe, maximum


def _place(candidate, equipment, pitch, module_count):
    rows = integer(equipment, "array_rows", default=1, minimum=1, maximum=6)
    layout = calculate_layout(candidate, {
        "module_count": math.ceil(module_count / rows),
        "module_width_m": number(equipment, "module_width_m", minimum=.05, maximum=10),
        "module_height_m": pitch["plan_depth_m"], "row_spacing_m": pitch["gap_m"],
        "azimuth": equipment["azimuth"]})
    layout["module_count"] = min(module_count, layout["module_count"] * rows)
    layout["requested_count"] = module_count
    layout["warnings"] = [warning for warning in layout["warnings"] if "요청" not in warning]
    if layout["module_count"] < module_count:
        layout["warnings"].append(f"가이드라인 이격거리로 {module_count:,}장 중 {layout['module_count']:,}장만 배치됩니다. "
                                  "발전량·비용은 입력 수량 기준이므로 수량 또는 경계를 조정하세요.")
    layout["array_rows"] = rows
    return layout


def _costs(equipment, costs, dc_kw, inverter, distance, floating):
    items = [
        ("module", "태양광 모듈", equipment["module_count"] * number(equipment, "module_price", minimum=0),
         f"{equipment['module_count']:,}장 × {number(equipment, 'module_price', minimum=0):,.0f}원", "가이드라인 표 3-9"),
        ("inverter", "인버터", inverter["cost"],
         " + ".join(f"{unit['kw']} kW × {unit['count']}대" for unit in inverter["units"]), "가이드라인 표 3-12"),
    ]
    junction = number(costs, "junction_box_unit", default=0, minimum=0)
    if junction:
        items.append(("junction", "접속반", inverter["junction_box_count"] * junction,
                      f"{inverter['junction_box_count']}면 × {junction:,.0f}원", "표 3-14 수량 · 사용자 단가"))
    if floating:
        items += [("float", "부유체", dc_kw * number(costs, "float_per_kw", minimum=0), "DC kW × 단가", "사용자 견적 가정"),
                  ("mooring", "계류장치", dc_kw * number(costs, "mooring_per_kw", minimum=0), "DC kW × 단가", "사용자 견적 가정")]
    structure = number(costs, "structure_per_kw", default=0, minimum=0)
    if structure:
        items.append(("structure", "구조물(지상·침전지)", dc_kw * structure, "DC kW × 단가", "사용자 견적 가정"))
    items += [
        ("electrical", "전기공사·기타 자재", dc_kw * number(costs, "electrical_per_kw", minimum=0), "DC kW × 단가", "사용자 견적 가정"),
        ("cable", "수중·연계 케이블", distance * number(costs, "cable_per_m", minimum=0), f"{distance:,.0f} m × 단가", "한전 접속점 연계거리 (부록 2.5)"),
        ("civil", "토목공사", number(costs, "civil", minimum=0), "총액", "사용자 견적 가정"),
        ("design", "설계·인허가", number(costs, "design_permitting", minimum=0), "총액", "사용자 견적 가정"),
        ("grid", "계통연계(한전 공사비)", number(costs, "grid_connection", minimum=0), "총액", "사용자 견적 가정"),
    ]
    rows = [{"key": key, "label": label, "amount": float(amount), "basis": basis, "source": source}
            for key, label, amount, basis, source in items]
    return rows, sum(row["amount"] for row in rows)


def run_analysis(snapshot):
    """Calculate solely from the immutable snapshot supplied by the API."""
    candidate = snapshot["candidate"]
    design = snapshot["design"]
    costs, finance = design["costs"], design["finance"]
    latitude, longitude = candidate["latitude"], candidate["longitude"]
    floating = candidate.get("site_type", "floating") == "floating"
    warnings = []

    # ① 설치대상지 선정
    factors = guideline.site_factors(latitude, longitude)
    equipment, pitch = guideline.resolve_equipment(design["equipment"], factors)
    equipment["albedo"] = .06 if floating else .2

    # ② 부지면적·기자재 → 설치 용량
    probe, maximum = _layout(candidate, equipment, pitch)
    if equipment.get("capacity_mode") == "area":
        if maximum is None:
            raise ValueError("후보지 경계가 없으면 면적 기준 용량을 계산할 수 없습니다. 모듈 수량을 입력하세요.")
        requested = math.floor(maximum * number(equipment, "area_use_pct", minimum=0, maximum=100) / 100)
    else:
        requested = integer(equipment, "module_count", minimum=1, maximum=200000)
    strings = guideline.string_design(requested, equipment)
    equipment["module_count"] = strings["modules_used"]
    dc_kw = equipment["module_count"] * equipment["module_power_w"] / 1000
    inverter = guideline.inverter_design(dc_kw, equipment.get("inverter_configuration", "auto"))
    equipment["ac_capacity_kw"] = inverter["ac_capacity_kw"]
    purpose = equipment.get("purpose", "sale")
    grid = guideline.grid_connection(dc_kw, purpose)
    layout = _place(candidate, equipment, pitch, equipment["module_count"]) if probe else None
    if layout is None:
        warnings.append("후보지 경계가 없어 면적·배치 검토를 생략했습니다(기존 발전소 재현 검토).")
    warnings += strings["warnings"]

    # ③ 연간 발전량: 물리 모델 + 운영실적 보정
    years = snapshot.get("weather", {}).get("years") or weather.long_term_years()
    irradiance = calibration.irradiance_factors()
    frame = weather.scale_irradiance(weather.hourly(latitude, longitude, years), irradiance)
    physics = long_term_energy(equipment, latitude, longitude, frame)
    reference = long_term_energy(calibration.standard_equipment(equipment["tilt"], equipment["azimuth"], floating)
                                 | ({"seasonal_tilts": equipment["seasonal_tilts"]} if equipment.get("seasonal_tilts") else {}),
                                 latitude, longitude, frame)
    calibrated = calibration.apply(reference, {"latitude": latitude, "longitude": longitude, "capacity_kw": dc_kw,
                                               "type": "floating" if floating else candidate.get("site_type", "plant")},
                                   exclude_plant=candidate.get("reference_plant_id"))
    use_calibrated = calibrated is not None and equipment.get("energy_basis", "calibrated") == "calibrated"
    if equipment.get("energy_basis", "calibrated") == "calibrated" and calibrated is None:
        warnings.append("운영실적 보정 모델이 없어 물리 모델 발전량을 사용했습니다 (scripts/build_calibration.py 실행 필요).")
    monthly = []
    for index, row in enumerate(physics["monthly"]):
        item = {"month": row["month"], "physics_kwh": row["energy_kwh"], "poa_kwh_m2": row["poa_kwh_m2"],
                "ghi_kwh_m2": row["ghi_kwh_m2"], "temp_air": row["temp_air"]}
        if calibrated:
            match = calibrated["monthly"][index]
            item.update(calibrated_kwh=match["energy_kwh"], p10_kwh=match["p10_kwh"], p90_kwh=match["p90_kwh"],
                        ratio=match["ratio"])
        item["energy_kwh"] = item["calibrated_kwh"] if use_calibrated else item["physics_kwh"]
        monthly.append(item)
    annual = sum(row["energy_kwh"] for row in monthly)
    hours = 8760

    # ④ 개략공사비
    distance, distance_basis = connection_distance(candidate)
    breakdown, capex = _costs(equipment, costs, dc_kw, inverter, distance, floating)
    operating = {"annual_om": dc_kw * number(costs, "annual_om_per_kw", minimum=0),
                 "replacement_cost": inverter["cost"], "replacement_year": costs.get("replacement_year", 12)}

    # ⑤ 예상수익 · ⑥ 재무성 분석
    economics = calculate_finance(annual, capex, operating, finance, purpose)
    stress = []
    cases = [(f"발전량 −{pct:g}%", 1 - pct / 100) for pct in finance.get("stress_pcts", [5, 10])]
    if use_calibrated:
        cases.insert(0, ("검증 하한 P10", calibrated["annual_p10_kwh"] / calibrated["annual_kwh"]))
    for label, factor in cases:
        case = calculate_finance(annual * factor, capex, operating, finance, purpose)
        stress.append({"label": label, "factor": factor, "annual_kwh": annual * factor, "bc": case["bc"],
                       "npv": case["npv"], "irr_pct": case["irr_pct"],
                       "required_price_per_kwh": case["required_price_per_kwh"]})
    substitution = guideline.energy_substitution(annual)

    result = {
        "capacity_dc_kw": dc_kw, "capacity_ac_kw": inverter["ac_capacity_kw"],
        "annual_kwh": annual, "specific_yield": annual / dc_kw,
        "capacity_factor_pct": annual / (dc_kw * hours) * 100,
        "daily_hours": annual / dc_kw / 365,
        "energy_basis": "calibrated" if use_calibrated else "physics",
        "monthly": monthly,
        "physics": {"annual_kwh": physics["annual_kwh"], "annual_by_year": physics["annual_by_year"],
                    "years": physics["years"]},
        "calibration": None if calibrated is None else {
            key: calibrated[key] for key in ("model", "model_label", "annual_kwh", "annual_p10_kwh", "annual_p90_kwh",
                                             "annual_by_year", "band_basis", "band_plants", "excluded_plant", "validation")},
        "steps": {
            "site": {**factors, "climate": kma.climate_check(latitude, longitude, monthly, physics["years"]),
                     "site_type": candidate.get("site_type", "floating"),
                     "structure_type": equipment.get("structure_type", "fixed"), "tilt": equipment["tilt"],
                     "azimuth": equipment["azimuth"], "tilt_mode": equipment.get("tilt_mode", "guideline")},
            "equipment": {
                "module": {key: equipment[key] for key in ("module_model", "module_power_w", "module_width_m",
                                                            "module_height_m", "module_price")},
                "module_preset": equipment.get("module_preset"),
                "area_m2": probe["area_m2"] if probe else None,
                "usable_area_m2": probe["usable_area_m2"] if probe else None,
                "max_modules_by_area": maximum, "requested_modules": requested,
                "module_count": equipment["module_count"], "pitch": pitch,
                "strings": strings, "inverter": inverter, "grid": grid, "purpose": purpose,
            },
            "costs": {"items": breakdown, "total": capex, "per_kw": capex / dc_kw,
                      "annual_om": operating["annual_om"], "replacement_cost": operating["replacement_cost"],
                      "replacement_year": operating["replacement_year"]},
            "revenue": {"purpose": purpose, "price_per_kwh": economics["effective_price_per_kwh"],
                        "first_year_revenue": economics["first_year_revenue"],
                        "first_year_sales_kwh": economics["first_year_sales_kwh"],
                        "first_year_self_use_kwh": economics["first_year_self_use_kwh"]},
            "substitution": substitution,
        },
        "economics": economics, "stress": stress, "layout": layout,
        "cable_distance_m": distance, "connection_distance_basis": distance_basis,
    }
    if candidate.get("reference_plant_id"):
        result["reference"] = reference_backtest(candidate["reference_plant_id"])
    assumptions = physics["provenance"]["assumptions"] + [
        f"설계 기준: {guideline.SOURCE} (부록 개략공사비 산정 Tool 절차).",
        "모듈 단가는 표 3-9, 인버터 구매비·구성은 표 3-12, 직렬 수는 표 3-13, 이격거리는 표 3-22를 따릅니다.",
        "부유체·계류·전기·토목·설계·계통 단가와 유지관리비는 가이드라인에 없는 사용자 견적 가정입니다.",
        "인버터 교체비는 표 3-12 구매비를 교체연도에 1회 반영합니다.",
        "B/C = 유입 현재가치 ÷ 유출 현재가치. 연말 세전 비차입 현금흐름이며 금융·세금·물가·잔존가치는 제외합니다.",
        "필요 판매단가 = 유출 현재가치 ÷ 할인 판매전력량 (B/C = 1이 되는 단가). 입찰가 결정이 아닌 후보지 비교용입니다.",
        distance_basis,
    ]
    if use_calibrated:
        assumptions.append(f"발전량은 {calibrated['model_label']} 결과이며, 범위는 {calibrated['band_basis']}입니다.")
    if irradiance:
        assumptions.append("ERA5 일사량에 기상청 ASOS 일사계 기반 월별 보정계수를 곱했습니다(장소 분리 검증에서 오차가 줄어 채택).")
    provenance = physics["provenance"]
    provenance.update(assumptions=assumptions, version=ENGINE_VERSION,
                      warnings=list(dict.fromkeys(provenance["warnings"] + warnings + economics["warnings"]
                                                  + (layout["warnings"] if layout else []))))
    if floating and (candidate.get("water_depth_m") is None or candidate.get("water_level_m") is None):
        provenance["warnings"].append("수심·수위 조사값이 없습니다. 계류 설계·수위 변동 검토가 필요합니다.")
    result["provenance"] = provenance
    return result


def period_model_rows(run, years):
    """Hourly model energy of a completed run's resolved design for given years.

    Used to compare uploaded measurements on the *same* dates: physics on the
    actual reanalysis weather, scaled by the run's monthly calibration factor
    (calibrated ÷ physics) when the run used the calibrated basis.
    """
    from .energy import interval_energy

    snapshot, result = run["snapshot"], run["result"]
    candidate = snapshot["candidate"]
    steps = result["steps"]
    equipment = {**snapshot["design"]["equipment"], "tilt": steps["site"]["tilt"],
                 "module_count": steps["equipment"]["module_count"], "ac_capacity_kw": result["capacity_ac_kw"],
                 **{key: steps["equipment"]["module"][key] for key in ("module_power_w", "module_width_m", "module_height_m")},
                 "albedo": .06 if candidate.get("site_type", "floating") == "floating" else .2}
    if steps["site"].get("structure_type") == "seasonal":
        equipment["seasonal_tilts"] = steps["site"]["seasonal_tilts"]
    frame = weather.scale_irradiance(weather.hourly(candidate["latitude"], candidate["longitude"], years),
                                     calibration.irradiance_factors())
    series, *_ = interval_energy(equipment, candidate["latitude"], candidate["longitude"], frame)
    factor = {row["month"]: (row["energy_kwh"] / row["physics_kwh"] if row["physics_kwh"] else 1.)
              for row in result["monthly"]}
    return [{"timestamp": stamp.isoformat(), "energy_kwh": float(kwh) * factor[stamp.month], "interval_minutes": 60}
            for stamp, kwh in series.kwh.items()]


def reference_backtest(plant_id):
    """Held-out (leave-one-plant-out) predictions of the selected model for one plant."""
    from .. import kwater

    stored = calibration.load_result()
    plant = kwater.plant(plant_id)
    if stored is None or plant is None:
        return None
    selected = stored["selected_model"]
    capacity = plant["capacity_kw"]
    rows = [{"year": row["year"], "month": row["month"], "measured_kwh": row["measured"] * capacity,
             "predicted_kwh": row["predicted"] * capacity, "physics_kwh": row["physics"] * capacity}
            for row in stored["predictions"] if row["plant_id"] == plant_id and row["model"] == selected]
    metrics = {item["model"]: {key: item[key] for key in ("mape_pct", "bias_pct", "plant_total_abs_error_pct", "months")}
               for item in stored["per_plant"] if item["plant_id"] == plant_id}
    return {"plant": plant, "model": selected, "model_label": stored["selected_label"], "rows": rows, "metrics": metrics,
            "note": "같은 날짜의 유효 실적일만 비교한 값입니다. 이 발전소를 학습에서 제외한 모델의 예측입니다."}
