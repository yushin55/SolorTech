"""Manufacturer catalog equipment (module datasheets and inverter product pages).

Module electrical values come from the manufacturers' Korean datasheets. No
manufacturer publishes a price, so prices are converted from the guideline's
per-unit tables (``price_basis``) until a quote is entered in the cost step.
"""

# 표 3-9: 수상용 450 Wp 225,000원/장 → 500원/Wp, 육상용 480 Wp 230,400원/장 → 480원/Wp.
GUIDELINE_FLOATING_PRICE_PER_W = 500
GUIDELINE_LAND_PRICE_PER_W = 480
# 표 3-12 100 kW 1대 1,500만원 → 150,000원/kW.
GUIDELINE_INVERTER_PRICE_PER_KW = 150000

# Datasheet values a catalog module applies to the string design and physics model.
ELECTRICAL_KEYS = ("vmp_v", "voc_v", "voltage_temp_coeff_pct", "gamma_pdc")

MODULES = {
    "hd_his_t650uj": {
        "label": "HD현대 UJ 시리즈 HiS-T650UJ-ES 650 Wp (TOPCon, 수상용)", "short_label": "HD현대 HiS-T650UJ",
        "manufacturer": "HD현대에너지솔루션", "series": "UJ 시리즈 (HiS-T650UJ-ES)", "floating": True,
        "module_power_w": 650, "efficiency_pct": 23.3,
        "module_width_m": 1.134, "module_height_m": 2.465, "thickness_mm": 35, "weight_kg": 35.0,
        "vmp_v": 47.75, "voc_v": 57.69, "imp_a": 13.62, "isc_a": 14.22,
        "voltage_temp_coeff_pct": -.25, "gamma_pdc": -.0029, "noct": "NOCT 41 ± 2°C", "max_system_v": 1500,
        "load_pa": "강설 5,400 Pa / 풍 5,400 Pa", "load_front_pa": 5400, "load_rear_pa": 5400,
        "load_basis": "데이터시트 강설·풍하중 (설계·시험 하중 구분 없음)",
        "warranty": "12년 품질 보증, 30년 성능 보증 (첫해 99%, 이후 0.4%/년)",
        "features": ["N형 TOPCon", "양면 단결정", "수상용", "국내 제조", "탄소배출량 검증제품"],
        "source": "HD현대에너지솔루션 UJ-ES 시리즈 데이터시트 (2026.03.25, 수상용)",
    },
}
for _item in MODULES.values():
    _per_w, _kind = ((GUIDELINE_FLOATING_PRICE_PER_W, "수상용") if _item["floating"]
                     else (GUIDELINE_LAND_PRICE_PER_W, "육상용"))
    _item["module_price"] = _item["module_power_w"] * _per_w
    _item["price_basis"] = f"제조사 가격 미공개 · 표 3-9 {_kind} 단가 {_per_w}원/Wp 환산 (견적 가정)"

INVERTERS = {
    "qvolt_p60ta": {"manufacturer": "한화큐셀", "model": "Q.VOLT P60TA", "kw": 60, "max_kva": 66,
                    "max_efficiency_pct": 98.32, "euro_efficiency_pct": 98.03, "mppt": 6, "channels": 12,
                    "fuse_a": "20 / 25 / 30", "weight_kg": 54.5, "size_mm": "788 × 821 × 339",
                    "features": ["퓨즈 내장 일체형", "AFCI", "RS485 2포트", "한전 출력제어 프로토콜"]},
    "qvolt_p110ta": {"manufacturer": "한화큐셀", "model": "Q.VOLT P110TA", "kw": 110, "max_kva": 121,
                     "max_efficiency_pct": 98.01, "euro_efficiency_pct": 97.73, "mppt": 10, "channels": 20,
                     "fuse_a": "20 / 25 / 30", "weight_kg": 96, "size_mm": "1006 × 891 × 329",
                     "features": ["퓨즈 내장 일체형", "AFCI", "RS485 2포트", "한전 출력제어 프로토콜"]},
    "qvolt_p125tx": {"manufacturer": "한화큐셀", "model": "Q.VOLT P125T-X", "kw": 125, "max_kva": 132,
                     "max_efficiency_pct": 98.2, "euro_efficiency_pct": 97.9, "mppt": 12, "channels": 24,
                     "fuse_a": "30", "weight_kg": 87, "size_mm": "984 × 708 × 328",
                     "features": ["LCD", "AFCI"]},
    "hd_h125": {"manufacturer": "HD현대에너지솔루션", "model": "H125 (HPC-125HL-V1~V4-OU)", "kw": 125,
                "rating": "125 kW@40°C", "max_efficiency_pct": 98.4, "euro_efficiency_pct": 98.07,
                "mppt": "9 또는 12", "channels": None, "weight_kg": "87~93", "size_mm": "1050 × 340.5 × 706 (V4: 942)",
                "features": ["지락차단", "모니터링", "계통안정강화", "소음 저감", "AFCI"]},
    "hd_h150": {"manufacturer": "HD현대에너지솔루션", "model": "H150 (HPC-150HL-V1~V3-OU)", "kw": 150,
                "rating": "150 kW@45°C", "max_efficiency_pct": 98.8, "euro_efficiency_pct": 98.3,
                "mppt": 6, "channels": None, "weight_kg": "109 (V3: 111)", "size_mm": "1118 × 384 × 840.9 (V3: 1095.6)",
                "features": ["지락차단", "모니터링", "계통안정강화", "스마트 온도감지", "AFCI"]},
    "hd_h350": {"manufacturer": "HD현대에너지솔루션", "model": "H350 (HPC-350HL-V1/V2-OU)", "kw": 350,
                "rating": "350 kW@45°C", "max_efficiency_pct": 99, "euro_efficiency_pct": 98.5,
                "mppt": 15, "channels": None, "weight_kg": 147, "size_mm": "1062 × 400 × 1112 (Fuse 포함)",
                "features": ["지락차단", "모니터링", "계통안정강화"]},
}
for _item in INVERTERS.values():
    _item["unit_cost"] = _item["kw"] * GUIDELINE_INVERTER_PRICE_PER_KW
    _item["price_basis"] = "제조사 가격 미공개 · 표 3-12 100 kW 단가 150,000원/kW 환산 (견적 가정)"
    _item["source"] = f"{_item['manufacturer']} 제품 페이지"
    _item["warranty"] = "5년 품질 보증" if _item["manufacturer"].startswith("HD") else None
