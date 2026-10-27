"""K-water 「태양광에너지 표준설계모델 가이드라인」 rules used by the review flow.

Every constant cites its table. Where the guideline gives no value (floating
structure, mooring, underwater cable, civil works), nothing is invented here:
those stay user-entered cost assumptions in the design inputs.
"""

import math

from .common import integer, number

SOURCE = "K-water 태양광에너지 표준설계모델 가이드라인"

# 표 3-9: module options (2021). price is KRW per module.
MODULES = {
    "floating_450": {"label": "수상용 단결정 450 Wp (친환경 고효율, IP67·Pb Free)", "module_power_w": 450,
                     "module_width_m": 1.030, "module_height_m": 2.171, "module_price": 225000,
                     "source": "표 3-8·3-9 수상용 모듈"},
    "land_480": {"label": "육상용 단결정 480 Wp (Half-cut)", "module_power_w": 480,
                 "module_width_m": 1.043, "module_height_m": 2.275, "module_price": 230400,
                 "source": "표 3-9 육상용 모듈"},
}

# 표 3-13 example (480 Wp): Vmp 44.81 V, Voc 53.61 V, voltage coefficient −0.27 %/°C.
STRING_EXAMPLE = {"vmp_v": 44.81, "voc_v": 53.61, "voltage_temp_coeff_pct": -.27}
MPPT_MIN_V, MPPT_MAX_V, VOC_MAX_V = 550., 830., 1000.   # 3.6.2 / 표 3-11 선정값
T_MIN_C, T_MAX_C = -30., 70.                             # 표 3-13 (동절기 강원 고려 −30°C, 설계지침 70°C)

# 표 3-12: inverter purchase cost per unit (million KRW).
INVERTER_UNITS = {100: 15e6, 500: 40e6, 1000: 64e6}
# 표 3-14: junction box channels and count per inverter size.
JUNCTION = {100: (16, 1), 500: (20, 4), 1000: (24, 6)}

# 표 3-18 regional optimum tilt (태양광 자원지도) by province.
PROVINCE_TILT = {"서울특별시": 33, "부산광역시": 33, "대구광역시": 33, "인천광역시": 33, "광주광역시": 33,
                 "대전광역시": 33, "울산광역시": 33, "세종특별자치시": 33, "경기도": 33, "충청북도": 33,
                 "충청남도": 33, "경상북도": 33, "경상남도": 33, "전북특별자치도": 30, "전라남도": 30,
                 "강원특별자치도": 33, "제주특별자치도": 24}
EAST_GANGWON_36 = {"동해시", "속초시", "강릉시", "삼척시", "양양군", "고성군"}   # 표 3-18 "동해, 속초 등"
JEONNAM_33 = {"구례군", "나주시"}                                              # 표 3-18 "구례, 나주, 남원 등"
# 표 3-19: Solar Pro optimum tilt at 43 K-water plants, keyed by the containing 시·군.
PLANT_CITY_TILT = {"시흥시": 30, "화성시": 30, "안산시": 30, "용인시": 30, "성남시": 30, "파주시": 31,
                   "남양주시": 31, "고양시": 31, "태백시": 31, "충주시": 31, "완주군": 29, "군산시": 29,
                   "아산시": 30, "천안시": 30, "청주시": 30, "공주시": 30, "부여군": 30, "보령시": 30,
                   "금산군": 30, "부안군": 30, "구미시": 28, "사천시": 30, "밀양시": 30, "양산시": 30,
                   "고령군": 31, "경산시": 31, "청도군": 31, "화순군": 30, "영암군": 30, "순천시": 31}
# 표 3-21 seasonal tilts (spring, summer, autumn, winter) for 가변형, by the same city keys.
SEASONAL_TILT = {
    **dict.fromkeys(["시흥시", "화성시", "안산시", "용인시", "성남시"], (28, 10, 28, 35)),
    **dict.fromkeys(["고양시", "파주시", "남양주시", "태백시", "충주시"], (30, 10, 30, 35)),
    **dict.fromkeys(["아산시", "천안시", "청주시", "공주시", "보령시", "금산군", "완주군", "군산시", "부안군", "부여군"],
                    (27, 10, 27, 33)),
    **dict.fromkeys(["구미시"], (27, 10, 27, 33)),
    **dict.fromkeys(["사천시", "밀양시", "양산시"], (30, 10, 30, 33)),
    **dict.fromkeys(["고령군", "경산시", "청도군"], (30, 8, 30, 33)),
    **dict.fromkeys(["영암군"], (25, 10, 25, 31)),
    **dict.fromkeys(["화순군"], (29, 10, 29, 35)),
}
SEASONS = {"spring": (3, 4, 5), "summer": (6, 7, 8), "autumn": (9, 10, 11), "winter": (12, 1, 2)}

# 표 3-4 structural factors.
WIND_SPEED = {"서울특별시": 30, "인천광역시": 30, "경기도": 30, "강원특별자치도": 40, "대전광역시": 40,
              "세종특별자치시": 40, "충청남도": 40, "충청북도": 40, "부산광역시": 45, "대구광역시": 45,
              "울산광역시": 45, "경상남도": 45, "경상북도": 45, "광주광역시": 40, "전라남도": 40,
              "전북특별자치도": 40, "제주특별자치도": 40}
SNOW_LOAD = {"울릉군": 7.0, "강릉시": 3.0, "속초시": 2.0}
SUN_ELEVATION_SPACING = 23.  # 표 3-22: 동지 오전 10시 태양고도
NEAR_KM = 50.

# Energy-substitution factors back-calculated from the guideline tool's own
# example rows (부록 표 1-1 / 2.7): every row reproduces with these values.
HOUSEHOLD_KWH = 4347.8      # kWh per household·year
OIL_TOE_PER_MWH = .25
CO2_T_PER_MWH = .47
PINE_PER_KWH = .07065


def _cities():
    from ..geocoding import _CITIES  # offline gazetteer of 시·군 centres by province

    for province, text in _CITIES.items():
        for item in text.split(";"):
            name, lat, lon = item.split(",")
            yield province, name, float(lat), float(lon)


def _distance_km(lat1, lon1, lat2, lon2):
    return math.hypot(lat1 - lat2, (lon1 - lon2) * math.cos(math.radians(lat1))) * 111.2


def _nearest(latitude, longitude, names=None):
    rows = [(_distance_km(latitude, longitude, lat, lon), province, name)
            for province, name, lat, lon in _cities() if names is None or name in names]
    return min(rows) if rows else None


def site_factors(latitude, longitude):
    """Step 1: design factors for the site from the guideline tables.

    The program-simulated K-water site tables (표 3-19·3-21) are preferred
    within 50 km; the guideline itself calls the 2015 resource map (표 3-18)
    and the theoretical formula (표 3-20) coarser.
    """
    distance_km, province, city = _nearest(latitude, longitude)
    plant = _nearest(latitude, longitude, PLANT_CITY_TILT)
    if plant and plant[0] <= NEAR_KM:
        tilt = PLANT_CITY_TILT[plant[2]]
        tilt_basis = f"표 3-19 K-water 정수장 프로그램 최적경사각 ({plant[2]} 권역, {plant[0]:.0f} km)"
    else:
        tilt = PROVINCE_TILT.get(province, 33)
        if province == "강원특별자치도" and city in EAST_GANGWON_36:
            tilt = 36
        if province == "전라남도" and city in JEONNAM_33:
            tilt = 33
        tilt_basis = f"표 3-18 태양광 자원지도 지역별 최적경사각 ({province})"
    seasonal_site = _nearest(latitude, longitude, SEASONAL_TILT)
    if seasonal_site and seasonal_site[0] <= NEAR_KM:
        seasonal = SEASONAL_TILT[seasonal_site[2]]
        seasonal_basis = f"표 3-21 계절별 최적경사각 ({seasonal_site[2]} 권역, {seasonal_site[0]:.0f} km)"
    else:
        seasonal = tuple(theoretical_seasonal_tilt(latitude).values())
        seasonal_basis = "표 3-20 이론식 (β = 90 − α, α = 90 − 위도 + δ, 계절 평균)"
    seismic = "Ⅱ" if province == "제주특별자치도" or (province == "강원특별자치도" and latitude >= 37.6) else "Ⅰ"
    return {
        "province": province, "nearest_city": city, "city_distance_km": distance_km,
        "region_basis": "내장 시·군 중심점 중 가장 가까운 곳 (행정경계 판정 아님)",
        "optimal_tilt": tilt, "tilt_basis": tilt_basis,
        "seasonal_tilts": dict(zip(SEASONS, seasonal)), "seasonal_basis": seasonal_basis,
        "azimuth": 180, "azimuth_basis": "3.5.1 정남향 원칙(현장 여건 시 동·서 45° 이내)",
        "wind_speed_ms": WIND_SPEED.get(province, 40), "snow_load_kn_m2": SNOW_LOAD.get(city, .8 if province == "인천광역시" else .5),
        "seismic_zone": seismic, "seismic_coeff_g": .22 if seismic == "Ⅱ" else .14,
        "structural_basis": "표 3-4 지역별 최대풍속·지상적설하중·지진구역",
    }


def theoretical_seasonal_tilt(latitude):
    """표 3-20: daily optimum β = 90 − α, α = 90 − φ + δ, averaged per season."""
    result = {}
    for season, months in SEASONS.items():
        values = []
        for day in range(1, 366):
            month = (day - 1) * 12 // 365 + 1
            if month in months:
                delta = 23.45 * math.sin(math.radians(360 / 365 * (day - 81)))
                values.append(90 - (90 - latitude + delta))
        result[season] = round(max(0, sum(values) / len(values)))
    return result


def array_pitch(module_height_m, rows, tilt):
    """표 3-22: X = L(cos α + sin α / tan 23°) with L the slanted array length."""
    length = module_height_m * rows
    alpha = math.radians(tilt)
    depth = length * math.cos(alpha)
    gap = length * math.sin(alpha) / math.tan(math.radians(SUN_ELEVATION_SPACING))
    return {"array_length_m": length, "plan_depth_m": depth, "gap_m": gap, "pitch_m": depth + gap}


def string_design(module_count, electrical):
    """표 3-13: allowed series count range and the chosen series/parallel layout."""
    vmp = number(electrical, "vmp_v", default=STRING_EXAMPLE["vmp_v"], minimum=1, maximum=200)
    voc = number(electrical, "voc_v", default=STRING_EXAMPLE["voc_v"], minimum=1, maximum=250)
    coeff = number(electrical, "voltage_temp_coeff_pct", default=STRING_EXAMPLE["voltage_temp_coeff_pct"],
                   minimum=-2, maximum=0) / 100
    if voc < vmp:
        raise ValueError("개방전압(Voc)은 최대전압(Vmp)보다 커야 합니다.")

    def at(value, temperature):
        return value - (25 - temperature) * value * coeff

    cold_vmp, cold_voc, hot_vmp, hot_voc = at(vmp, T_MIN_C), at(voc, T_MIN_C), at(vmp, T_MAX_C), at(voc, T_MAX_C)
    maximum = min(math.floor(MPPT_MAX_V / cold_vmp), math.floor(VOC_MAX_V / cold_voc))
    minimum = max(math.ceil(MPPT_MIN_V / hot_vmp), math.ceil(MPPT_MIN_V / hot_voc))
    warnings = []
    if minimum > maximum:
        raise ValueError(f"모듈 전압으로 인버터 MPPT {MPPT_MIN_V:.0f}~{MPPT_MAX_V:.0f} V를 만족하는 직렬 수가 없습니다.")
    series = (minimum + maximum) // 2
    parallel = module_count // series
    if parallel < 1:
        raise ValueError(f"모듈 수({module_count})가 직렬 {series}장보다 적습니다.")
    if module_count % series:
        warnings.append(f"직렬 {series}장 단위로 맞추기 위해 모듈 {module_count % series}장을 제외했습니다.")
    if voc * series > 750:
        warnings.append(f"직렬군 개방전압 {voc * series:.0f} V > 750 V: KEC 521.1에 따라 울타리 등 안전조치가 필요합니다.")
    return {"series": series, "parallel": parallel, "modules_used": series * parallel,
            "series_min": minimum, "series_max": maximum,
            "cold_vmp_v": cold_vmp, "cold_voc_v": cold_voc, "hot_vmp_v": hot_vmp, "hot_voc_v": hot_voc,
            "string_voc_v": voc * series, "basis": "표 3-13 직렬회로수 산정식 (−30°C·70°C, MPPT 550~830 V, Voc 1,000 V)",
            "electrical_source": electrical.get("electrical_source", "가이드라인 480 Wp 예시 제원"),
            "warnings": warnings}


def inverter_design(dc_kw, configuration="auto"):
    """표 3-12: multi-unit (≥2) at least cost unless one unit saves more than 20 %."""
    options = []
    # Within the table's 1 MW range multi-unit rows combine only 100/500 kW units;
    # 1,000 kW units appear there only as the single-unit option.
    for big in range(0, math.ceil(dc_kw / 1000) + 2):
        for mid in range(0, 4):
            for small in range(0, 5):
                units = {1000: big, 500: mid, 100: small}
                total = sum(size * count for size, count in units.items())
                count = big + mid + small
                if big and count > 1 and dc_kw <= 1000:
                    continue
                if count and total >= dc_kw - 1e-9:
                    cost = sum(INVERTER_UNITS[size] * n for size, n in units.items())
                    options.append((cost, count, total, units))
    if not options:
        raise ValueError("인버터 구성을 찾을 수 없습니다.")
    multi = min((option for option in options if option[1] >= 2), key=lambda o: (o[0], o[2]), default=None)
    single = min((option for option in options if option[1] == 1), key=lambda o: (o[0], o[2]), default=None)
    if configuration == "single" and single:
        chosen, rule = single, "단일구성 (사용자 선택)"
    elif configuration == "multi" and multi:
        chosen, rule = multi, "멀티구성 (사용자 선택)"
    elif single and (multi is None or single[0] < multi[0] * .8):
        chosen, rule = single, "단일구성: 멀티 대비 20% 초과 절감 (표 3-12 경제성 예외)"
    else:
        chosen, rule = multi or single, "멀티구성 원칙 (표 3-12, 고장 시 나머지 인버터로 발전)"
    cost, count, total, units = chosen
    junction = [{"inverter_kw": size, "channels": JUNCTION[size][0], "count": JUNCTION[size][1] * n}
                for size, n in units.items() if n]
    return {"units": [{"kw": size, "count": n, "unit_cost": INVERTER_UNITS[size]} for size, n in units.items() if n],
            "ac_capacity_kw": float(total), "unit_count": count, "cost": cost, "rule": rule,
            "junction_boxes": junction, "junction_box_count": sum(item["count"] for item in junction),
            "basis": "표 3-12 인버터 용량별 1대당 구매비용 · 표 3-14 인버터 용량별 접속반 채널수"}


def grid_connection(dc_kw, purpose):
    """표 3-5 / 부록 2.4(3): connection voltage by purpose and capacity."""
    if purpose == "self":
        if dc_kw < 500:
            return {"voltage": "저압 3상 380 V", "network": "소내 연계", "voltage_variation_limit_pct": 6}
        return {"voltage": "특고압 3상 22.9 kV", "network": "소내 연계", "voltage_variation_limit_pct": 3}
    if dc_kw < 500:
        return {"voltage": "저압 단상 220 V · 3상 380 V", "network": "한전 배전선로", "voltage_variation_limit_pct": 6}
    if dc_kw <= 20000:
        return {"voltage": "특고압 3상 22.9 kV", "network": "한전 배전선로", "voltage_variation_limit_pct": 3}
    return {"voltage": "가이드라인 범위(20 MW) 초과 — 송전망 연계 별도 검토", "network": "별도 검토",
            "voltage_variation_limit_pct": None}


def energy_substitution(annual_kwh):
    """부록 2.7: households supplied, oil substitution, pine-tree equivalent, CO₂ avoided."""
    return {"households": annual_kwh / HOUSEHOLD_KWH, "oil_toe": annual_kwh / 1000 * OIL_TOE_PER_MWH,
            "pine_trees": annual_kwh * PINE_PER_KWH, "co2_t": annual_kwh / 1000 * CO2_T_PER_MWH,
            "basis": "가이드라인 부록 표 1-1·2.7 예시값에서 역산한 계수 (가구당 4,347.8 kWh/년, 0.25 TOE/MWh, 0.47 tCO₂/MWh, 소나무 0.07065그루/kWh)"}


def resolve_equipment(equipment, factors):
    """Apply guideline module presets and automatic tilt to a design's equipment."""
    resolved = dict(equipment)
    preset = MODULES.get(resolved.get("module_preset"))
    if preset:
        for key in ("module_power_w", "module_width_m", "module_height_m", "module_price"):
            resolved[key] = preset[key]
    if resolved.get("tilt_mode", "guideline") == "guideline":
        resolved["tilt"] = factors["optimal_tilt"]
    if resolved.get("structure_type") == "seasonal":
        resolved["seasonal_tilts"] = dict(factors["seasonal_tilts"])
    rows = integer(resolved, "array_rows", default=1, minimum=1, maximum=6)
    tilt = number(resolved, "tilt", minimum=0, maximum=90)
    # A seasonal frame casts its longest winter shadow at the steepest setting.
    spacing_tilt = max(resolved.get("seasonal_tilts", {}).values(), default=tilt)
    pitch = array_pitch(number(resolved, "module_height_m", minimum=.05, maximum=10), rows, spacing_tilt)
    if resolved.get("spacing_mode", "guideline") != "guideline":
        gap = number(resolved, "row_spacing_m", minimum=0, maximum=100)
        pitch.update(gap_m=gap, pitch_m=pitch["plan_depth_m"] + gap, basis="사용자 입력 행간 이격")
    else:
        pitch["basis"] = f"표 3-22 이격거리 산출식 (경사 {spacing_tilt:g}°, 태양고도 23°)"
    return resolved, pitch
