"""Land/building review assumptions, kept separate from floating design rules."""

import math

from . import guideline


def resolve(candidate, equipment, factors):
    equipment = dict(equipment)
    factors = dict(factors)
    kind = candidate.get("site_type")
    if kind not in ("land", "rooftop"):
        resolved, pitch = guideline.resolve_equipment(equipment, factors)
        resolved["shading_loss_pct"] = candidate.get("shading_loss_pct", 0)
        return resolved, pitch, factors, []
    # A latitude-based starting angle is an assumption, not the nearby water-plant table.
    factors.update(optimal_tilt=round(max(0, min(60, candidate["latitude"] - 5))),
                   tilt_basis="육상 예비설계 가정: 위도 − 5° (현장 최적화 전)",
                   azimuth_basis="가대형: 설계 방위 입력값 / 지붕 밀착형: 지붕 조사 방위")
    factors["seasonal_tilts"] = guideline.theoretical_seasonal_tilt(candidate["latitude"])
    factors["seasonal_basis"] = "위도 기반 계절별 이론 경사각 (현장 최적화 전)"
    warnings = []
    if kind == "rooftop" and candidate.get("roof_mount", "rack") == "flush":
        equipment.update(tilt_mode="manual", structure_type="fixed",
                         tilt=candidate.get("roof_tilt_deg", 10), azimuth=candidate.get("roof_azimuth_deg", 180))
    resolved, pitch = guideline.resolve_equipment(equipment, factors)
    resolved.update(energy_basis="physics", shading_loss_pct=candidate.get("shading_loss_pct", 0),
                    temperature_model="close_mount_glass_glass" if kind == "rooftop" and
                    candidate.get("roof_mount") == "flush" else "open_rack_glass_glass")
    if kind == "rooftop" and candidate.get("roof_mount") == "flush":
        depth = pitch["array_length_m"] * math.cos(math.radians(resolved["tilt"]))
        pitch.update(plan_depth_m=depth, gap_m=0, pitch_m=depth,
                     basis="지붕 밀착형: 지붕 경사·방위 적용, 수평 투영 길이로 배치 (통로는 제외 구역 지정)")
        if depth < .05:
            raise ValueError("수직 지붕·벽면은 평면 배치로 검토할 수 없습니다. 경사각을 확인하세요.")
    if kind == "land":
        slope = candidate.get("terrain_slope_deg")
        limit = candidate.get("slope_limit_deg", 15)
        if slope is None:
            warnings.append("부지 경사 조사값 미입력: 토목·배수·기초 및 지자체 입지 조건을 확인하세요.")
        elif slope > limit:
            warnings.append(f"부지 경사 {slope:g}°가 사용자 검토 한계 {limit:g}°를 초과합니다. 인허가 기준 판정은 아닙니다.")
    else:
        allowable, system = candidate.get("roof_allowable_load_kg_m2"), candidate.get("roof_system_load_kg_m2")
        if allowable is None or system is None:
            warnings.append("지붕 허용 추가하중·설치 추가하중 미확인: 모듈·가대·밸러스트를 포함한 구조 검토가 필요합니다.")
        elif system > allowable:
            warnings.append(f"지붕 설치 추가하중 {system:g} kg/m²가 허용 추가하중 {allowable:g} kg/m²를 초과합니다.")
    return resolved, pitch, factors, warnings
