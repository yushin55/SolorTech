"""Six-step review following the guideline tool (부록 2.1), on real records.

① 설치대상지 선정 → ② 부지면적·기자재 → ③ 설치용량·연간발전량 → ④ 개략공사비
→ ⑤ 예상수익 → ⑥ 재무성 분석·에너지 대체효과. Step ③ runs pvlib on multi-year
reanalysis weather and, when a calibration exists, corrects it with the model
validated on K-water operating records.
"""

import math

from .. import calibration, kma, stations, weather
from . import guideline
from .common import ENGINE_VERSION, integer, number
from .energy import long_term_energy, orientation_poa
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


CAPACITY_MODE_LABELS = {"site_area": "부지 면적 입력", "capacity": "총 설비용량 입력",
                        "count": "모듈 수량 직접 입력", "area": "후보지 경계 면적 × 이용률"}


def capacity_plan(equipment, pitch, maximum=None):
    """Module count requested by the chosen input method, with the assumptions used.

    * site_area: 부지 면적 × (1 − 여유 면적 비율) ÷ 모듈 1장당 점유면적.
      점유면적 = 모듈 폭 × 어레이 행 피치 ÷ 어레이 단수(표 3-22 이격거리 포함).
    * capacity: 목표 총 설비용량 ÷ 모듈 정격출력 (올림).
    """
    mode = equipment.get("capacity_mode", "count")
    power = number(equipment, "module_power_w", minimum=1, maximum=2000)
    width = number(equipment, "module_width_m", minimum=.05, maximum=10)
    rows = integer(equipment, "array_rows", default=1, minimum=1, maximum=6)
    footprint = pitch["pitch_m"] * width / rows
    plan = {"mode": mode, "mode_label": CAPACITY_MODE_LABELS.get(mode, mode), "module_power_w": power,
            "module_footprint_m2": footprint, "module_area_m2": width * number(equipment, "module_height_m"),
            "row_pitch_m": pitch["pitch_m"], "row_gap_m": pitch["gap_m"], "pitch_basis": pitch.get("basis"),
            "array_rows": rows}
    if mode == "site_area":
        area = number(equipment, "site_area_m2", minimum=0)
        reserve = number(equipment, "reserve_pct", default=20, minimum=0, maximum=99.9)
        usable = area * (1 - reserve / 100)
        requested = math.floor(usable / (pitch["pitch_m"] * width)) * rows
        if requested < 1:
            raise ValueError(f"부지 면적 {area:,.0f} m²에서는 여유 면적을 빼면 모듈을 1장도 배치할 수 없습니다. "
                             "면적을 늘리거나 여유 면적 비율을 줄이세요.")
        plan.update(site_area_m2=area, reserve_pct=reserve, usable_area_m2=usable,
                    ground_coverage_pct=requested * plan["module_area_m2"] / area * 100)
    elif mode == "capacity":
        target = number(equipment, "target_capacity_kw", minimum=0)
        requested = math.ceil(target * 1000 / power - 1e-9)
        plan.update(target_capacity_kw=target)
    elif mode == "area":
        if maximum is None:
            raise ValueError("후보지 경계가 없으면 경계 면적 기준 용량을 계산할 수 없습니다. "
                             "부지 면적 입력 방식이나 총 설비용량 입력 방식을 쓰세요.")
        requested = math.floor(maximum * number(equipment, "area_use_pct", minimum=0, maximum=100) / 100)
    else:
        requested = integer(equipment, "module_count", minimum=1, maximum=200000)
    if requested > 200000:
        raise ValueError(f"계산된 모듈 수({requested:,}장)가 한도 200,000장을 넘습니다. 면적이나 용량을 줄이세요.")
    plan.update(requested_modules=requested, requested_dc_kw=requested * power / 1000)
    return plan


COST_CATEGORY = {"module": "설비(모듈)", "inverter": "설비(인버터)", "junction": "설비(접속반)",
                 "float": "부유체", "mooring": "계류장치", "structure": "구조물",
                 "electrical": "전기공사·자재", "cable": "케이블", "civil": "시공(토목)",
                 "design": "설계·인허가", "grid": "계통연계"}


def _costs(equipment, costs, dc_kw, inverter, distance, floating):
    items = [
        ("module", "태양광 모듈", equipment["module_count"] * number(equipment, "module_price", minimum=0),
         f"{equipment['module_count']:,}장 × {number(equipment, 'module_price', minimum=0):,.0f}원",
         equipment.get("module_price_source", "가이드라인 표 3-9")),
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
        items.append(("structure", "구조물(지상·건축물·침전지)", dc_kw * structure, "DC kW × 단가", "사용자 견적 가정"))
    items += [
        ("electrical", "전기공사·기타 자재", dc_kw * number(costs, "electrical_per_kw", minimum=0), "DC kW × 단가", "사용자 견적 가정"),
        ("cable", "수중·연계 케이블", distance * number(costs, "cable_per_m", minimum=0), f"{distance:,.0f} m × 단가", "한전 접속점 연계거리 (부록 2.5)"),
        ("civil", "토목공사", number(costs, "civil", minimum=0), "총액", "사용자 견적 가정"),
        ("design", "설계·인허가", number(costs, "design_permitting", minimum=0), "총액", "사용자 견적 가정"),
        ("grid", "계통연계(한전 공사비)", number(costs, "grid_connection", minimum=0), "총액", "사용자 견적 가정"),
    ]
    rows = [{"key": key, "label": label, "category": COST_CATEGORY.get(key, label), "amount": float(amount),
             "basis": basis, "source": source} for key, label, amount, basis, source in items]
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
    plan = capacity_plan(equipment, pitch, maximum)
    requested = plan["requested_modules"]
    strings = guideline.string_design(requested, equipment)
    equipment["module_count"] = strings["modules_used"]
    dc_kw = equipment["module_count"] * equipment["module_power_w"] / 1000
    inverter = guideline.inverter_design(dc_kw, equipment.get("inverter_configuration", "auto"))
    equipment["ac_capacity_kw"] = inverter["ac_capacity_kw"]
    purpose = equipment.get("purpose", "sale")
    grid = guideline.grid_connection(dc_kw, purpose)
    layout = _place(candidate, equipment, pitch, equipment["module_count"]) if probe else None
    if layout is None and plan["mode"] not in ("site_area", "capacity"):
        warnings.append("후보지 경계가 없어 지도 배치 검토를 생략했습니다(기존 발전소 재현 검토).")
    warnings += strings["warnings"]

    # ③ 연간 발전량: 물리 모델 + 운영실적 보정
    years = snapshot.get("weather", {}).get("years") or weather.long_term_years()
    irradiance, irradiance_info = calibration.irradiance_correction(latitude, longitude)
    frame = weather.scale_irradiance(weather.hourly(latitude, longitude, years), irradiance)
    physics = long_term_energy(equipment, latitude, longitude, frame)
    reference = long_term_energy(calibration.standard_equipment(equipment["tilt"], equipment["azimuth"], floating)
                                 | ({"seasonal_tilts": equipment["seasonal_tilts"]} if equipment.get("seasonal_tilts") else {}),
                                 latitude, longitude, frame)
    calibrated = calibration.apply(reference, {"latitude": latitude, "longitude": longitude, "capacity_kw": dc_kw,
                                               "type": "floating" if floating else candidate.get("site_type", "plant")},
                                   exclude_plant=candidate.get("reference_plant_id"))
    shading = number(equipment, "shading_loss_pct", default=0, minimum=0, maximum=99.9)
    if shading:
        _scale_energy(physics, calibrated, 1 - shading / 100)
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
    scenarios = _price_scenarios(annual, capex, operating, finance, purpose, economics)
    first_revenue = economics["first_year_revenue"]
    monthly_revenue = [{"month": row["month"], "energy_kwh": row["energy_kwh"],
                        "revenue": first_revenue * row["energy_kwh"] / annual if annual else 0.} for row in monthly]
    angles = _orientation_table(equipment, latitude, longitude, frame, annual)
    nearby = stations.nearest(latitude, longitude, 3)

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
                     "weather_station": nearby[0], "nearby_stations": nearby,
                     "irradiance_station": irradiance_info,
                     "weather_basis": "시간별 일사·기온·풍속: 후보지 좌표의 ERA5 재분석(1991~2020, Open-Meteo). "
                                      "가장 가까운 기상청 ASOS 관측소는 좌표 거리로 찾고, 관측 자료가 있는 관측소는 "
                                      "일사량 보정·평년값 비교에 사용합니다.",
                     "angles": angles,
                     "site_type": candidate.get("site_type", "floating"),
                     "structure_type": equipment.get("structure_type", "fixed"), "tilt": equipment["tilt"],
                     "azimuth": equipment["azimuth"], "tilt_mode": equipment.get("tilt_mode", "guideline")},
            "equipment": {
                "module": {key: equipment[key] for key in ("module_model", "module_power_w", "module_width_m",
                                                            "module_height_m", "module_price")},
                "module_preset": equipment.get("module_preset"),
                "area_m2": probe["area_m2"] if probe else None,
                "usable_area_m2": probe["usable_area_m2"] if probe else None,
                "max_modules_by_area": maximum, "requested_modules": requested, "plan": plan,
                "module_manufacturer": equipment.get("module_manufacturer", ""),
                "module_source": equipment.get("module_source", ""),
                "module_price_source": equipment.get("module_price_source", ""),
                "shading_loss_pct": shading, "system_loss_pct": equipment.get("system_loss_pct", 14),
                "module_count": equipment["module_count"], "pitch": pitch,
                "strings": strings, "inverter": inverter, "grid": grid, "purpose": purpose,
            },
            "costs": {"items": breakdown, "total": capex, "per_kw": capex / dc_kw,
                      "annual_om": operating["annual_om"], "replacement_cost": operating["replacement_cost"],
                      "replacement_year": operating["replacement_year"]},
            "revenue": {"purpose": purpose, "price_per_kwh": economics["effective_price_per_kwh"],
                        "first_year_revenue": economics["first_year_revenue"],
                        "first_year_sales_kwh": economics["first_year_sales_kwh"],
                        "first_year_self_use_kwh": economics["first_year_self_use_kwh"],
                        "monthly": monthly_revenue, "scenarios": scenarios,
                        "total_revenue": economics["total_revenue"], "years": finance.get("years", 20)},
            "substitution": substitution,
        },
        "economics": economics, "stress": stress, "layout": layout,
        "assumption_table": _assumption_table(equipment, costs, finance, plan, floating, distance, inverter, distance_basis),
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
    if shading:
        assumptions.append(f"주변 장애물 음영 손실 {shading:g}%를 월별 발전량에 일괄 반영했습니다(사용자 입력 가정).")
    if use_calibrated:
        assumptions.append(f"발전량은 {calibrated['model_label']} 결과이며, 범위는 {calibrated['band_basis']}입니다.")
    if irradiance:
        where = (f"후보지에서 가장 가까운 일사계 관측소인 {irradiance_info['name']}({irradiance_info['stn']}, "
                 f"{irradiance_info['distance_km']:.1f} km)" if irradiance_info.get("mode") == "nearest"
                 else f"기상청 {irradiance_info.get('name') or ''} 관측소")
        assumptions.append(f"ERA5 일사량에 {where}의 ASOS 일사계 기반 월별 보정계수를 곱했습니다"
                           "(장소 분리 검증에서 오차가 줄어 채택).")
    provenance = physics["provenance"]
    provenance.update(assumptions=assumptions, version=ENGINE_VERSION,
                      warnings=list(dict.fromkeys(provenance["warnings"] + warnings + economics["warnings"]
                                                  + (layout["warnings"] if layout else []))))
    if floating and (candidate.get("water_depth_m") is None or candidate.get("water_level_m") is None):
        provenance["warnings"].append("수심·수위 조사값이 없습니다. 계류 설계·수위 변동 검토가 필요합니다.")
    result["provenance"] = provenance
    return result


def _scale_energy(physics, calibrated, factor):
    """Apply a uniform loss (e.g. shading) to physics and calibrated energy outputs."""
    physics["annual_kwh"] *= factor
    for row in physics["monthly"]:
        row["energy_kwh"] *= factor
    for row in physics["annual_by_year"]:
        row["energy_kwh"] *= factor
    if calibrated:
        for key in ("annual_kwh", "annual_p10_kwh", "annual_p90_kwh"):
            calibrated[key] *= factor
        for row in calibrated["monthly"]:
            for key in ("energy_kwh", "p10_kwh", "p90_kwh", "physics_kwh"):
                if key in row:
                    row[key] *= factor
        for row in calibrated.get("annual_by_year", []):
            for key in ("energy_kwh", "calibrated_kwh", "kwh"):
                if key in row:
                    row[key] *= factor


def _price_scenarios(annual, capex, operating, finance, purpose, economics):
    """Revenue and returns when the sale price changes (fixed price per kWh)."""
    cases = []
    required = economics.get("required_price_per_kwh")
    if required is not None:
        cases.append(("최소 필요 판매단가 (B/C = 1)", required, "reference"))
    cases.append(("사용자 설정 판매단가", economics["effective_price_per_kwh"], "user"))
    for price in finance.get("price_scenarios", []) or []:
        cases.append((f"시나리오 {price:,.1f}원/kWh", float(price), "scenario"))
    rows, seen = [], set()
    for label, price, kind in cases:
        if round(price, 6) in seen and kind == "scenario":
            continue
        seen.add(round(price, 6))
        result = calculate_finance(annual, capex, operating, {**finance, "sale_mode": "fixed", "fixed_price": price},
                                   purpose)
        rows.append({"label": label, "kind": kind, "price_per_kwh": price,
                     "first_year_revenue": result["first_year_revenue"], "total_revenue": result["total_revenue"],
                     "net_profit": result["net_profit"], "npv": result["npv"], "bc": result["bc"],
                     "irr_pct": result["irr_pct"], "payback_years": result["payback_years"]})
    return rows


def _orientation_table(equipment, latitude, longitude, frame, annual):
    """Estimated annual energy for other tilt/azimuth choices on the same weather.

    Scales the analysed annual energy by the ratio of plane-of-array irradiation.
    Seasonal (가변형) structures are compared on their fixed-equivalent tilt.
    """
    try:
        tilt = float(equipment["tilt"])
        azimuth = float(equipment["azimuth"])
        tilts = sorted({0., 10., 20., 30., 40., 50., round(tilt, 1)})
        azimuths = sorted({90., 135., 180., 225., 270., round(azimuth, 1)})
        combos = [(t, a) for t in tilts for a in azimuths]
        rows = orientation_poa(latitude, longitude, frame, combos, equipment.get("albedo", .2))
        base = next(row["poa_kwh_m2"] for row in rows if row["tilt"] == round(tilt, 1) and row["azimuth"] == round(azimuth, 1))
        if base <= 0:
            return None
        for row in rows:
            row["ratio"] = row["poa_kwh_m2"] / base
            row["annual_kwh"] = annual * row["ratio"]
            row["selected"] = row["tilt"] == round(tilt, 1) and row["azimuth"] == round(azimuth, 1)
        best = max(rows, key=lambda row: row["poa_kwh_m2"])
        return {"selected": {"tilt": tilt, "azimuth": azimuth}, "rows": rows,
                "best": {"tilt": best["tilt"], "azimuth": best["azimuth"], "ratio": best["ratio"]},
                "seasonal": equipment.get("structure_type") == "seasonal",
                "basis": "같은 30년 기상에서 경사면 일사량(등방성 전이) 비율로 분석 발전량을 환산한 추정값입니다. "
                         "온도·입사각·음영 차이는 다시 계산하지 않았습니다."}
    except Exception:  # comparison is auxiliary; never fail the run for it
        return None


def _assumption_table(equipment, costs, finance, plan, floating, distance, inverter, distance_basis):
    """Assumed values with unit and source, for the result screen and the report."""
    estimate = "사용자 견적 가정"
    user = "사용자 입력"
    rows = [
        ("설비", "모듈", f"{equipment.get('module_manufacturer') or '-'} {equipment['module_model']}", "",
         equipment.get("module_source") or user),
        ("설비", "모듈 정격출력", equipment["module_power_w"], "W/장", "모듈 제원 출처와 같음"),
        ("설비", "모듈 크기(가로×세로)", f"{equipment['module_width_m']:.3f} × {equipment['module_height_m']:.3f}", "m",
         "모듈 제원 출처와 같음"),
        ("설비", "모듈 단가", equipment["module_price"], "원/장", equipment.get("module_price_source", user)),
        ("설비", "인버터 구매비", inverter["cost"], "원", "가이드라인 표 3-12"),
        ("배치", "용량 산정 방식", plan["mode_label"], "", user),
        ("배치", "어레이 행 피치(모듈 깊이+이격)", round(plan["row_pitch_m"], 2), "m", plan.get("pitch_basis") or "가이드라인 표 3-22"),
        ("배치", "모듈 1장당 점유면적", round(plan["module_footprint_m2"], 2), "m²/장", "모듈 폭 × 행 피치 ÷ 어레이 단수"),
    ]
    if plan["mode"] == "site_area":
        rows += [("배치", "부지 면적", plan["site_area_m2"], "m²", user),
                 ("배치", "여유 면적(통로·유지보수·외곽 이격)", plan["reserve_pct"], "%", "초기 데모 가정값 · 사용자 수정 가능")]
    if plan["mode"] == "capacity":
        rows.append(("배치", "목표 총 설비용량", plan["target_capacity_kw"], "kW", user))
    rows += [
        ("발전량", "시스템 손실(배선·오염·불일치 등)", equipment.get("system_loss_pct", 14), "%", "PVWatts 기본 손실 가정"),
        ("발전량", "주변 장애물 음영 손실", equipment.get("shading_loss_pct", 0), "%", user),
    ]
    if floating:
        rows += [("공사비", "부유체 단가", costs.get("float_per_kw", 0), "원/kW", estimate),
                 ("공사비", "계류장치 단가", costs.get("mooring_per_kw", 0), "원/kW", estimate)]
    else:
        rows.append(("공사비", "구조물 단가", costs.get("structure_per_kw", 0), "원/kW", estimate))
    rows += [
        ("공사비", "전기공사·기타 자재 단가", costs.get("electrical_per_kw", 0), "원/kW", estimate),
        ("공사비", "케이블 단가", costs.get("cable_per_m", 0), "원/m", estimate),
        ("공사비", "케이블 연계거리", round(distance), "m", distance_basis or "연결점 지정값"),
        ("공사비", "토목공사", costs.get("civil", 0), "원", estimate),
        ("공사비", "설계·인허가", costs.get("design_permitting", 0), "원", estimate),
        ("공사비", "계통연계(한전 공사비)", costs.get("grid_connection", 0), "원", estimate),
        ("운영", "유지관리비", costs.get("annual_om_per_kw", 0), "원/kW·년", estimate),
        ("운영", "인버터 교체 시점", costs.get("replacement_year", 12), "년차", "표 3-12 구매비 1회 반영"),
        ("재무", "사업 기간", finance.get("years", 20), "년", user),
        ("재무", "할인율", finance.get("discount_pct", 4.5), "%", user),
        ("재무", "연간 발전량 감소율(열화)", finance.get("degradation_pct", .5), "%/년", user),
        ("재무", "출력제한률", finance.get("curtailment_pct", 0), "%", user),
    ]
    if finance.get("sale_mode", "fixed") == "fixed":
        rows.append(("재무", "판매단가", finance.get("fixed_price", 150), "원/kWh", "사용자 설정(상·하한 없음)"))
    else:
        rows += [("재무", "SMP", finance.get("smp_price", 0), "원/kWh", user),
                 ("재무", "REC 가격", finance.get("rec_price", 0), "원/REC", user),
                 ("재무", "REC 가중치", finance.get("rec_weight", 1), "", user)]
    return [{"group": g, "label": label, "value": value, "unit": unit, "source": source}
            for g, label, value, unit, source in rows]


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
                                     calibration.irradiance_factors(candidate["latitude"], candidate["longitude"]))
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
