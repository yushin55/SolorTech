"""Land/building site conditions, kept separate from the floating design rules.

Ported from the team repository (yushin55/SolorTech): roof flush mounting, the
matching temperature model, and survey warnings for terrain slope and roof load.
The tilt itself still follows this app's guideline/angle-comparison flow.
"""

import math

from . import guideline


def resolve(candidate, equipment, factors):
    """Resolve equipment for the candidate's site type → (equipment, pitch, warnings)."""
    kind = candidate.get("site_type")
    equipment = dict(equipment)
    flush = kind == "building" and candidate.get("roof_mount", "rack") == "flush"
    if flush:
        equipment.update(tilt_mode="manual", structure_type="fixed",
                         tilt=candidate.get("roof_tilt_deg", 10), azimuth=candidate.get("roof_azimuth_deg", 180))
    resolved, pitch = guideline.resolve_equipment(equipment, factors)
    if kind not in ("land", "building"):
        return resolved, pitch, []
    resolved["temperature_model"] = "close_mount_glass_glass" if flush else "open_rack_glass_glass"
    warnings = []
    if flush:
        depth = pitch["array_length_m"] * math.cos(math.radians(resolved["tilt"]))
        if depth < .05:
            raise ValueError("수직 지붕·벽면은 평면 배치로 검토할 수 없습니다. 지붕 경사각을 확인하세요.")
        pitch.update(plan_depth_m=depth, gap_m=0, pitch_m=depth,
                     basis="지붕 밀착형: 지붕 경사·방위 적용, 수평 투영 길이로 배치 (통로는 제외 구역 지정)")
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
    return resolved, pitch, warnings
