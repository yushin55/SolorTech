"""Six-step review following the guideline tool (부록 2.1), on real records.

① 설치대상지 선정 → ② 부지면적·기자재 → ③ 설치용량·연간발전량 → ④ 개략공사비
→ ⑤ 예상수익 → ⑥ 재무성 분석·에너지 대체효과. Step ③ runs pvlib on multi-year
reanalysis weather and, when a calibration exists, corrects it with the model
validated on K-water operating records.
"""

import math

from .. import calibration, kma, weather
from . import catalog, guideline, siting, sizing
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
    if pitch["pitch_m"] <= 0 or pitch["plan_depth_m"] < .05:
        raise ValueError("수직 패널은 평면 배치로 검토할 수 없습니다. 경사각·이격거리를 확인하세요.")
    probe = calculate_layout(candidate, {"module_count": 0, "module_width_m": width,
                                         "module_height_m": pitch["plan_depth_m"],
                                         "row_spacing_m": pitch["gap_m"], "azimuth": equipment["azimuth"]})
    maximum = math.floor(probe["usable_area_m2"] / (pitch["pitch_m"] * width)) * rows
    return probe, maximum


AIR_DENSITY = 1.225  # kg/m³, 표준대기


def _module_loads(equipment, factors):
    """Catalog module: weight on the floats and a simple check of its rated load against 표 3-4."""
    spec = catalog.MODULES.get(equipment.get("module_preset"))
    if not spec:
        return None
    area = spec["module_width_m"] * spec["module_height_m"]
    wind = .5 * AIR_DENSITY * factors["wind_speed_ms"] ** 2
    snow = factors["snow_load_kn_m2"] * 1000
    # Wind acts as pressure or suction, so the weaker side governs.
    wind_rating = min(spec["load_front_pa"], spec["load_rear_pa"])
    return {"weight_kg": spec["weight_kg"], "module_count": equipment["module_count"],
            "total_weight_kg": spec["weight_kg"] * equipment["module_count"], "weight_per_m2": spec["weight_kg"] / area,
            "wind_speed_ms": factors["wind_speed_ms"], "wind_pressure_pa": wind, "wind_rating_pa": wind_rating,
            "wind_ok": wind <= wind_rating, "snow_load_pa": snow, "snow_rating_pa": spec["load_front_pa"],
            "snow_ok": snow <= spec["load_front_pa"],
            "rating_basis": spec["load_basis"],
            "basis": "간이 검토: 표 3-4 최대풍속의 속도압 ½ρV²·지상적설하중을 모듈 허용하중(제조사)과 비교. "
                     "가스트영향계수·풍력계수·경사 보정은 미반영이므로 구조계산서로 확인해야 합니다."}


def _module_comparison(equipment, pitch, probe):
    """Same rows, tilt and spacing rule with only the module swapped (표 3-9 presets vs catalog)."""
    rows = integer(equipment, "array_rows", default=1, minimum=1, maximum=6)
    spacing_tilt = max(equipment.get("seasonal_tilts", {}).values(), default=equipment["tilt"])
    usable = probe["usable_area_m2"] if probe else None
    items = []
    for key, spec in {**guideline.MODULES, **catalog.MODULES}.items():
        option = guideline.array_pitch(spec["module_height_m"], rows, spacing_tilt)
        step = (option["pitch_m"] if equipment.get("spacing_mode", "guideline") == "guideline"
                else option["plan_depth_m"] + pitch["gap_m"])
        count = math.floor(usable / (step * spec["module_width_m"])) * rows if usable else None
        items.append({"id": key, "label": spec["short_label"], "module_power_w": spec["module_power_w"],
                      "pitch_m": step, "kw_per_1000m2": rows / (step * spec["module_width_m"]) * spec["module_power_w"],
                      "max_modules": count, "max_kw": None if count is None else count * spec["module_power_w"] / 1000,
                      "price_per_kw": spec["module_price"] / spec["module_power_w"] * 1000,
                      "price_source": spec.get("price_basis", spec["source"]),
                      "selected": key == equipment.get("module_preset")})
    return {"items": items, "usable_area_m2": usable,
            "basis": f"배열 {rows}단 · 이격 기준 경사 {spacing_tilt:g}° 동일, 모듈만 교체"}


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


def _apply_quotes(equipment, costs, inverter):
    """Quoted unit prices from step ④ replace guideline / converted catalog prices."""
    module_quote = number(costs, "module_unit_price", default=0, minimum=0)
    if module_quote:
        equipment["module_price"] = module_quote
    equipment["module_price_source"] = (
        "사용자 견적" if module_quote else
        "카탈로그 · 표 3-9 W당 단가 환산 (견적 가정)" if equipment.get("module_preset") in catalog.MODULES else
        "사용자 입력" if equipment.get("module_preset") == "custom" else "가이드라인 표 3-9")
    inverter_quote = number(costs, "inverter_unit_price", default=0, minimum=0)
    if inverter.get("model_id") and inverter_quote:
        inverter["units"][0]["unit_cost"] = inverter_quote
        inverter["cost"] = inverter_quote * inverter["unit_count"]
    inverter["price_source"] = (
        "사용자 견적" if inverter.get("model_id") and inverter_quote else
        "카탈로그 · 표 3-12 kW당 단가 환산 (견적 가정)" if inverter.get("model_id") else "가이드라인 표 3-12")


def _costs(equipment, costs, dc_kw, inverter, distance, floating, site_type=None):
    items = [
        ("module", "태양광 모듈", equipment["module_count"] * number(equipment, "module_price", minimum=0),
         f"{equipment['module_count']:,}장 × {number(equipment, 'module_price', minimum=0):,.0f}원/장",
         equipment["module_price_source"]),
        ("inverter", "인버터", inverter["cost"],
         " + ".join(f"{unit.get('model', '')} {unit['kw']} kW × {unit['count']}대".strip() for unit in inverter["units"]),
         inverter["price_source"]),
    ]
    junction = number(costs, "junction_box_unit", default=0, minimum=0)
    if junction:
        items.append(("junction", "접속반", inverter["junction_box_count"] * junction,
                      f"{inverter['junction_box_count']}면 × {junction:,.0f}원", "표 3-14 수량 · 사용자 단가"))
    if floating:
        items += [("float", "부유체", dc_kw * number(costs, "float_per_kw", minimum=0), f"{dc_kw:g} kW × {costs['float_per_kw']:,.0f}원/kW", "사용자 견적 가정"),
                  ("mooring", "계류장치", dc_kw * number(costs, "mooring_per_kw", minimum=0), f"{dc_kw:g} kW × {costs['mooring_per_kw']:,.0f}원/kW", "사용자 견적 가정")]
    structure = number(costs, "structure_per_kw", default=0, minimum=0)
    if structure:
        items.append(("structure", "구조물" if floating else "가대·기초·건축물 구조물", dc_kw * structure, f"{dc_kw:g} kW × {structure:,.0f}원/kW", "사용자 견적 가정"))
    items += [
        ("electrical", "전기공사·기타 자재", dc_kw * number(costs, "electrical_per_kw", minimum=0), f"{dc_kw:g} kW × {costs['electrical_per_kw']:,.0f}원/kW", "사용자 견적 가정"),
        ("cable", "수중·연계 케이블" if floating else "육상·건축물 연계 케이블", distance * number(costs, "cable_per_m", minimum=0), f"{distance:,.0f} m × {costs['cable_per_m']:,.0f}원/m", "연계거리 × 사용자 견적 가정 단가"),
        ("civil", "건축·방수·보강 공사" if site_type == "rooftop" else "토목공사", number(costs, "civil", minimum=0), "총액 (원)", "사용자 견적 가정"),
        ("design", "설계·인허가", number(costs, "design_permitting", minimum=0), "총액 (원)", "사용자 견적 가정"),
        ("grid", "계통연계(한전 공사비)", number(costs, "grid_connection", minimum=0), "총액 (원)", "사용자 견적 가정"),
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

    asset_source = candidate.get("solartech_source")
    if asset_source:
        asset = asset_source["asset"]
        warnings.append(f"SolarTech 제원 출처: {asset_source['file']} · {asset['source_sheet']} {asset['source_row']}행. "
                        "원본에 모듈 치수·전기특성·가격과 인버터 효율이 없어 해당 입력값은 별도 확인이 필요합니다. "
                        "인버터 원본 제원은 참조용이며 계산에는 선택한 인버터 모델을 사용합니다.")
        if asset.get("capacity_mismatch"):
            warnings.append(f"원본 전체 용량 {asset['capacity_kw']:g} kW와 모듈 합산 용량 "
                            f"{asset['calculated_module_capacity_kw']:g} kW가 다릅니다. 확인 입력한 목표 용량으로 계산합니다.")

    # ① 설치대상지 선정
    factors = guideline.site_factors(latitude, longitude)
    equipment, pitch, factors, site_warnings = siting.resolve(candidate, design["equipment"], factors)
    warnings += site_warnings
    equipment["albedo"] = .06 if floating else .2

    # ② 부지면적·기자재 → 설치 용량
    probe, maximum = _layout(candidate, equipment, pitch)
    new_count = sizing.input_count(equipment, pitch)
    if new_count is not None:
        requested = new_count
    elif equipment.get("capacity_mode") == "area":
        if maximum is None:
            raise ValueError("후보지 경계가 없으면 면적 기준 용량을 계산할 수 없습니다. 모듈 수량을 입력하세요.")
        requested = math.floor(maximum * number(equipment, "area_use_pct", minimum=0, maximum=100) / 100)
    else:
        requested = integer(equipment, "module_count", minimum=1, maximum=200000)
    if new_count is None and candidate.get("site_type") in ("land", "rooftop") and probe:
        placed = _place(candidate, equipment, pitch, min(requested, 200000))["module_count"]
        if placed < requested:
            warnings.append(f"경계·이격·제외 구역 반영 후 실제 배치 가능한 {placed:,}장으로 용량·발전량·비용을 계산했습니다 (요청 {requested:,}장).")
        requested = min(requested, placed)
        if requested == 0:
            raise ValueError("경계 이격·제외 구역을 반영하면 배치 가능한 모듈이 없습니다. 경계·이격·모듈 조건을 확인하세요.")
    strings = sizing.strings_for(requested, equipment)
    equipment["module_count"] = strings["modules_used"]
    dc_kw = equipment["module_count"] * equipment["module_power_w"] / 1000
    inverter = guideline.inverter_design(dc_kw, equipment.get("inverter_configuration", "auto"),
                                         equipment.get("inverter_model"), strings["parallel"])
    equipment["ac_capacity_kw"] = inverter["ac_capacity_kw"]
    _apply_quotes(equipment, costs, inverter)
    purpose = equipment.get("purpose", "sale")
    grid = guideline.grid_connection(dc_kw, purpose)
    layout = _place(candidate, equipment, pitch, equipment["module_count"]) if probe else None
    if new_count is not None:
        warnings.append("입력 면적·목표 용량 기반 예비 산정입니다. 지도 경계에 모두 배치되는지는 별도 확인해야 합니다.")
    if layout is None:
        warnings.append("후보지 경계가 없어 면적·배치 검토를 생략했습니다(기존 발전소 재현 검토).")
    warnings += strings["warnings"] + inverter.get("warnings", [])
    loads = _module_loads(equipment, factors)
    if loads and not loads["wind_ok"]:
        warnings.append(f"최대풍속 {loads['wind_speed_ms']:g} m/s 속도압 {loads['wind_pressure_pa']:,.0f} Pa가 "
                        f"모듈 허용하중 {loads['wind_rating_pa']:,} Pa를 넘습니다.")
    if loads and not loads["snow_ok"]:
        warnings.append(f"지상적설하중 {loads['snow_load_pa']:,.0f} Pa가 모듈 전면 허용하중 "
                        f"{loads['snow_rating_pa']:,} Pa를 넘습니다. 다른 모듈 또는 구조 보강을 검토하세요.")

    # ③ 연간 발전량: 물리 모델 + 운영실적 보정
    years = snapshot.get("weather", {}).get("years") or weather.long_term_years()
    station_selection = snapshot.get("weather", {}).get("station_selection")
    station_active = bool(station_selection and station_selection.get("profile"))
    irradiance = None if station_active else calibration.irradiance_factors()
    frame = weather.scale_irradiance(weather.hourly(latitude, longitude, years), irradiance)
    station_factors = []
    if station_active:
        frame, station_factors = kma.apply_station_profile(frame, station_selection)
        warnings.append("기상청 관측소 월별 프로파일을 사용한 데모 예측입니다. 기존 운영실적 보정·P10–P90는 적용하지 않습니다.")
        if station_selection["selected"]["distance_km"] > 60:
            warnings.append("연결 관측소가 후보지에서 60 km 이상 떨어져 있습니다. 현지 기상 대표성을 확인하세요.")
    physics = long_term_energy(equipment, latitude, longitude, frame)
    reference = None if station_active or candidate.get("site_type") in ("land", "rooftop") else long_term_energy(calibration.standard_equipment(equipment["tilt"], equipment["azimuth"], floating)
                                 | ({"seasonal_tilts": equipment["seasonal_tilts"]} if equipment.get("seasonal_tilts") else {}),
                                 latitude, longitude, frame)
    calibrated = None if station_active or candidate.get("site_type") in ("land", "rooftop") else calibration.apply(reference, {"latitude": latitude, "longitude": longitude, "capacity_kw": dc_kw,
                                               "type": "floating" if floating else candidate.get("site_type", "plant")},
                                   exclude_plant=candidate.get("reference_plant_id"))
    use_calibrated = calibrated is not None and equipment.get("energy_basis", "calibrated") == "calibrated"
    if not station_active and equipment.get("energy_basis", "calibrated") == "calibrated" and calibrated is None:
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
    # Isolate orientation effects: same module count, inverter, losses and weather.
    orientation_comparison = []
    conditions = [("선택 조건", equipment["tilt"], equipment["azimuth"], True),
                  ("남향 20°", 20, 180, False), ("남향 30°", 30, 180, False),
                  ("동향 30°", 30, 90, False), ("서향 30°", 30, 270, False)]
    for label, tilt, azimuth, chosen in conditions:
        if chosen:
            energy = physics["annual_kwh"]
        else:
            option = {k: v for k, v in equipment.items() if k != "seasonal_tilts"}
            option.update(tilt=tilt, azimuth=azimuth)
            energy = long_term_energy(option, latitude, longitude, frame)["annual_kwh"]
        orientation_comparison.append({"label": label, "tilt": tilt, "azimuth": azimuth, "annual_kwh": energy,
                                       "difference_pct": (energy / physics["annual_kwh"] - 1) * 100 if physics["annual_kwh"] else 0})
    hours = 8760

    # ④ 개략공사비
    distance, distance_basis = connection_distance(candidate)
    breakdown, capex = _costs(equipment, costs, dc_kw, inverter, distance, floating, candidate.get("site_type"))
    operating = {"annual_om": dc_kw * number(costs, "annual_om_per_kw", minimum=0),
                 "replacement_cost": inverter["cost"], "replacement_year": costs.get("replacement_year", 12)}

    # ⑤ 예상수익 · ⑥ 재무성 분석
    economics = calculate_finance(annual, capex, operating, finance, purpose)
    price_scenarios = []
    for price in finance.get("price_scenarios", [100, 150, 200]):
        case = calculate_finance(annual, capex, operating, {**finance, "sale_mode": "fixed", "fixed_price": price}, purpose)
        price_scenarios.append({"price_per_kwh": price, "annual_revenue": case["first_year_revenue"],
                                "npv": case["npv"], "payback_years": case["payback_years"], "net_profit": case["net_profit"]})
    revenue_monthly = []
    for row in monthly:
        # Spread fixed annual self-consumption proportionally, preserving annual totals.
        share = row["energy_kwh"] / annual if annual else 0
        revenue_monthly.append({"month": row["month"], "generation_kwh": row["energy_kwh"],
                                "sales_kwh": economics["first_year_sales_kwh"] * share,
                                "self_use_kwh": economics["first_year_self_use_kwh"] * share,
                                "revenue": economics["first_year_revenue"] * share})
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
        "sizing": sizing.preview(candidate, design["equipment"]) if new_count is not None else None,
        "weather_station": station_selection,
        "orientation_comparison": orientation_comparison,
        "orientation_basis": "선택 조건별 예상 발전량 비교 · 동일 설비용량·기상·음영손실의 물리 모델. 선택 조건은 계절 가변각을 유지하고 대안은 고정각입니다. 재배치·구조 안전·행간 음영 변화는 별도 검토합니다.",
        "price_scenarios": price_scenarios,
        "revenue_monthly": revenue_monthly,
        "financial_assumptions": [
            {"label": "판매단가", "value": economics["effective_price_per_kwh"], "unit": "원/kWh", "source": finance.get("price_source", "사용자 시나리오 가정")},
            {"label": "연 유지관리 단가", "value": costs["annual_om_per_kw"], "unit": "원/kW·년", "source": "사용자 견적 가정"},
            {"label": "할인율", "value": finance["discount_pct"], "unit": "%/년", "source": "사용자 재무 가정"},
            {"label": "열화율", "value": finance["degradation_pct"], "unit": "%/년", "source": "사용자 재무 가정"},
            {"label": "출력제한율", "value": finance["curtailment_pct"], "unit": "%", "source": "사용자 운영 가정"}],
        "physics": {"annual_kwh": physics["annual_kwh"], "annual_by_year": physics["annual_by_year"],
                    "years": physics["years"]},
        "calibration": None if calibrated is None else {
            key: calibrated[key] for key in ("model", "model_label", "annual_kwh", "annual_p10_kwh", "annual_p90_kwh",
                                             "annual_by_year", "band_basis", "band_plants", "excluded_plant", "validation")},
        "steps": {
            "site": {**factors, "climate": kma.climate_check(latitude, longitude, monthly, physics["years"]),
                     "conditions": {key: candidate.get(key) for key in (
                         "boundary_setback_m", "shading_loss_pct", "terrain_slope_deg", "slope_limit_deg", "roof_mount",
                         "roof_tilt_deg", "roof_azimuth_deg", "roof_allowable_load_kg_m2", "roof_system_load_kg_m2")},
                     "site_type": candidate.get("site_type", "floating"),
                     "structure_type": equipment.get("structure_type", "fixed"), "tilt": equipment["tilt"],
                     "azimuth": equipment["azimuth"], "tilt_mode": equipment.get("tilt_mode", "guideline")},
            "equipment": {
                "module": {key: equipment[key] for key in ("module_model", "module_power_w", "module_width_m",
                                                            "module_height_m", "module_price")},
                "module_preset": equipment.get("module_preset"),
                "module_catalog": catalog.MODULES.get(equipment.get("module_preset")),
                "inverter_catalog": catalog.INVERTERS.get(equipment.get("inverter_model")),
                "module_loads": loads, "module_comparison": _module_comparison(equipment, pitch, probe),
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
        "필요 판매단가 = 유출 현재가치 ÷ 할인 판매전력량 (B/C = 1이 되는 단가, 균등화발전원가 LCOE와 같은 정의). "
        "입찰가 결정이 아닌 후보지 비교용입니다.",
        distance_basis,
        "신규 후보지 매출 = 예측 판매전력량 × 사용자 판매단가. 실제 판매실적이 아닙니다. 단가 입력은 상하한 제한이 없습니다.",
    ]
    if new_count is not None:
        assumptions.append(result["sizing"]["basis"])
    if station_selection:
        assumptions.append(station_selection["basis"])
        result["weather_station"] = {**station_selection, "applied_factors": station_factors}
    if economics.get("financing"):
        loan = economics["financing"]
        assumptions.append(f"자금 조달(사용자 가정): 총 공사비의 {loan['loan_pct']:g}% 융자, 연 {loan['loan_rate_pct']:g}%, "
                           f"거치 {loan['grace_years']}년 후 {loan['loan_years']}년 원리금균등 상환. "
                           "자기자본 IRR·DSCR에만 쓰이며 B/C·NPV·IRR은 비차입 기준입니다.")
    if candidate.get("site_type") in ("land", "rooftop"):
        assumptions[0:0] = [
            "육상·건축물 전용 검토: 수평 투영 경계에서 경계 이격·제외 구역을 차감하고 실제 배치 수량으로 계산합니다.",
            f"추가 음영손실 {equipment['shading_loss_pct']:g}%를 시스템 손실과 별도로 곱합니다. 입력 음영손실을 중복 반영하지 마세요.",
            f"온도 모델: pvlib SAPM {equipment['temperature_model']}. 건축물 밀착형은 지붕 경사·방위를 따릅니다.",
            "수상 발전소 보정·P10–P90를 적용하지 않고 물리 모델 발전량을 사용합니다. 경사 한계·이격·하중은 사용자 조사·설계 가정이며 법정 기준이 아닙니다.",
        ]
        assumptions = [value.replace("부유체·계류·전기·토목·설계·계통", "가대·기초·전기·토목·설계·계통") for value in assumptions]
        assumptions = [value.replace("입력 알베도(수면 0.06)", "육상·건축물 알베도 0.2")
                       .replace("SAPM open_rack_glass_glass 온도", f"SAPM {equipment['temperature_model']} 온도")
                       for value in assumptions]
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
    if candidate.get("site_type") in ("land", "rooftop"):
        resolved, _, _, _ = siting.resolve(candidate, snapshot["design"]["equipment"], steps["site"])
        equipment.update({key: resolved[key] for key in ("azimuth", "tilt", "shading_loss_pct", "temperature_model")})
    if steps["site"].get("structure_type") == "seasonal":
        equipment["seasonal_tilts"] = steps["site"]["seasonal_tilts"]
    station_selection = snapshot.get("weather", {}).get("station_selection")
    station_active = bool(station_selection and station_selection.get("profile"))
    frame = weather.scale_irradiance(weather.hourly(candidate["latitude"], candidate["longitude"], years),
                                     None if station_active else calibration.irradiance_factors())
    if station_active:
        frame, _ = kma.apply_station_profile(frame, station_selection)
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
