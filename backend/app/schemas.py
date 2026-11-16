from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True, strict=True)


Name = Annotated[str, Field(min_length=1, max_length=120)]
NonNegative = Annotated[float, Field(ge=0, le=1e15)]


class Polygon(StrictModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]]

    @model_validator(mode="after")
    def valid_polygon(self):
        from shapely.geometry import shape

        if not self.coordinates or sum(len(r) for r in self.coordinates) > 10000:
            raise ValueError("폴리곤은 1개 이상의 고리와 최대 10,000개 좌표가 필요합니다.")
        for ring in self.coordinates:
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError("폴리곤 고리는 닫혀 있고 최소 4개 좌표여야 합니다.")
            for point in ring:
                if len(point) != 2 or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90:
                    raise ValueError("좌표는 [경도, 위도] 범위여야 합니다.")
        geometry = shape(self.model_dump())
        if not geometry.is_valid or geometry.is_empty or geometry.area <= 0:
            raise ValueError("유효한 면적의 자기 교차 없는 폴리곤이 필요합니다.")
        bounds = geometry.bounds
        if bounds[2]-bounds[0] > 1 or bounds[3]-bounds[1] > 1:
            raise ValueError("후보지 경계는 위도·경도 각각 1도 이내의 수면이어야 합니다.")
        return self


class ProjectCreate(StrictModel):
    name: Name
    description: str = Field(default="", max_length=3000)
    demo: bool = False


class ProjectPatch(StrictModel):
    name: Name | None = None
    description: str | None = Field(default=None, max_length=3000)


# 설치장소 유형: 지상(평지·경사지) · 건축물(옥상·지붕) · 수상. plant/basin은 K-water 정수장·침전지 기존 시설.
SiteType = Literal["land", "building", "floating", "plant", "basin"]


class CandidateCreate(StrictModel):
    name: Name
    latitude: float = Field(ge=-89, le=89)
    longitude: float = Field(ge=-180, le=180)
    # A boundary is optional only for an existing plant reproduced by capacity.
    geometry: Polygon | None = None
    exclusions: list[Polygon] = Field(default_factory=list, max_length=100)
    grid_point: list[float] | None = None
    cable_distance_m: float | None = Field(default=None, ge=0, le=1000000)
    water_depth_m: float | None = Field(default=None, ge=0, le=1000)
    water_level_m: float | None = Field(default=None, ge=-500, le=10000)
    site_type: SiteType = "floating"
    # 지상·건축물 현장 조건 (수상에는 쓰지 않음). None = 현장 조사값 미입력
    boundary_setback_m: float = Field(default=0, ge=0, le=100)
    terrain_slope_deg: float | None = Field(default=None, ge=0, lt=90)
    slope_limit_deg: float = Field(default=15, ge=0, lt=90)
    roof_mount: Literal["rack", "flush"] = "rack"
    roof_tilt_deg: float = Field(default=10, ge=0, le=90)
    roof_azimuth_deg: float = Field(default=180, ge=90, le=270)
    roof_allowable_load_kg_m2: float | None = Field(default=None, ge=0, le=10000)
    roof_system_load_kg_m2: float | None = Field(default=None, ge=0, le=10000)
    solartech_asset_id: str | None = Field(default=None, max_length=100)
    reference_plant_id: str | None = Field(default=None, max_length=100)
    source: str = Field(default="", max_length=300)

    @field_validator("grid_point")
    @classmethod
    def valid_grid_point(cls, value):
        if value is not None and (len(value) != 2 or not -180 <= value[0] <= 180 or not -90 <= value[1] <= 90):
            raise ValueError("연결 지점은 [경도, 위도]입니다.")
        return value


class Equipment(StrictModel):
    """가이드라인 ①설치대상지 · ②부지면적·기자재 입력."""
    structure_type: Literal["fixed", "seasonal"] = "fixed"
    tilt_mode: Literal["guideline", "manual"] = "guideline"
    tilt: float = Field(default=30, ge=0, le=90)
    azimuth: float = Field(default=180, ge=90, le=270)
    module_preset: Literal["floating_450", "land_480", "qcells_xl_g11s_590", "hdhes_t440nf",
                           "senergy_sl85_66hdx_730u", "ls_pvm_s350f4b", "lg_lg340s2w_w4", "custom"] = "floating_450"
    module_manufacturer: str = Field(default="", max_length=120)
    module_model: Name = "수상용 단결정 450 Wp (가이드라인 표 3-9)"
    module_source: str = Field(default="", max_length=300)
    module_power_w: float = Field(default=450, ge=1, le=2000)
    module_width_m: float = Field(default=1.030, ge=.05, le=10)
    module_height_m: float = Field(default=2.171, ge=.05, le=10)
    module_price: NonNegative = 225000
    vmp_v: float = Field(default=44.81, gt=0, le=200)
    voc_v: float = Field(default=53.61, gt=0, le=250)
    voltage_temp_coeff_pct: float = Field(default=-.27, ge=-2, le=0)
    # site_area: 부지 면적 → 설치 가능 모듈 수 · capacity: 목표 총 설비용량 → 필요 모듈 수
    # count: 모듈 수량 직접(기존 설비 재현) · area: 그린 경계 면적 × 이용률
    capacity_mode: Literal["site_area", "capacity", "count", "area"] = "count"
    module_count: int = Field(default=2400, gt=0, le=200000)
    site_area_m2: float = Field(default=10000, gt=0, le=1e8)
    target_capacity_kw: float = Field(default=1000, gt=0, le=1e6)
    reserve_pct: float = Field(default=20, ge=0, lt=100)
    area_use_pct: float = Field(default=10, gt=0, le=100)
    array_rows: int = Field(default=1, ge=1, le=6)
    spacing_mode: Literal["guideline", "manual"] = "guideline"
    row_spacing_m: float = Field(default=1.2, ge=0, le=100)
    inverter_configuration: Literal["auto", "multi", "single"] = "auto"
    inverter_model: Literal["guideline", "dass_dsp_33125kshk_nj1"] = "guideline"
    purpose: Literal["sale", "self"] = "sale"
    gamma_pdc: float = Field(default=-0.0035, ge=-0.02, le=0)
    inverter_efficiency: float = Field(default=0.96, ge=.5, le=1)
    system_loss_pct: float = Field(default=14, ge=0, lt=100)
    shading_loss_pct: float = Field(default=0, ge=0, lt=100)
    energy_basis: Literal["calibrated", "physics"] = "calibrated"


class Costs(StrictModel):
    """가이드라인 ④개략공사비. 모듈·인버터는 가이드라인 단가, 나머지는 사용자 견적 가정."""
    float_per_kw: NonNegative = 300000
    mooring_per_kw: NonNegative = 160000
    structure_per_kw: NonNegative = 0
    electrical_per_kw: NonNegative = 180000
    junction_box_unit: NonNegative = 0
    cable_per_m: NonNegative = 120000
    civil: NonNegative = 70000000
    design_permitting: NonNegative = 50000000
    grid_connection: NonNegative = 60000000
    annual_om_per_kw: NonNegative = 27000
    replacement_year: int = Field(default=12, ge=1, le=50)
    module_unit_price: NonNegative = 0
    inverter_unit_price: NonNegative = 0


class Finance(StrictModel):
    """가이드라인 ⑤예상수익 · ⑥재무성 분석."""
    years: int = Field(default=20, ge=1, le=50)
    discount_pct: float = Field(default=4.5, ge=0, le=50)
    degradation_pct: float = Field(default=0.5, ge=0, le=20)
    sale_mode: Literal["fixed", "smp_rec"] = "fixed"
    # 사용자가 정하는 판매단가: 상·하한 없이 입력(유한한 값만)
    fixed_price: float = 150
    smp_price: NonNegative = 100
    rec_price: NonNegative = 60000
    rec_weight: float = Field(default=1, ge=0, le=10)
    curtailment_pct: float = Field(default=0, ge=0, le=100)
    self_use_kwh: NonNegative = 0
    retail_price: NonNegative = 0
    stress_pcts: list[float] = Field(default_factory=lambda: [5, 10], max_length=6)
    # 자금 조달 (선택): 0% = 전액 자기자본. B/C·NPV·IRR은 가이드라인대로 비차입 기준을 유지한다.
    loan_pct: float = Field(default=0, ge=0, le=100)
    loan_rate_pct: float = Field(default=4.5, ge=0, le=50)
    loan_years: int = Field(default=10, ge=1, le=50)
    grace_years: int = Field(default=0, ge=0, le=20)
    price_scenarios: list[float] = Field(default_factory=list, max_length=6)

    @field_validator("stress_pcts")
    @classmethod
    def valid_stress(cls, value):
        if any(not 0 < item < 100 for item in value):
            raise ValueError("발전량 감소율은 0~100% 사이여야 합니다.")
        return value


class DesignCreate(StrictModel):
    name: Name
    candidate_id: str = Field(min_length=1, max_length=100)
    equipment: Equipment = Field(default_factory=Equipment)
    costs: Costs = Field(default_factory=Costs)
    finance: Finance = Field(default_factory=Finance)


def defaults(site_type=None):
    values = {"equipment": Equipment().model_dump(), "costs": Costs().model_dump(),
              "finance": Finance().model_dump()}
    if site_type is None:
        return values
    # Same starting values as the frontend's designDefaults (site type → module preset).
    from .engine.guideline import MODULES
    preset = {"floating": "floating_450", "building": "hdhes_t440nf"}.get(site_type, "land_480")
    module = MODULES[preset]
    values["equipment"].update(
        module_preset=preset, module_manufacturer=module["manufacturer"], module_model=module["label"],
        module_source=module["source"], capacity_mode="capacity",
        **{key: module[key] for key in ("module_power_w", "module_width_m", "module_height_m", "module_price",
                                        "vmp_v", "voc_v", "voltage_temp_coeff_pct", "gamma_pdc")
           if key in module})
    if site_type != "floating":
        values["costs"].update(float_per_kw=0, mooring_per_kw=0)
    return values
