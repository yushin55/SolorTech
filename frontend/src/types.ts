export type Polygon = { type: "Polygon"; coordinates: number[][][] };
export type SiteType = "floating" | "plant" | "basin" | "land";
export type Candidate = {
  id: string;
  project_id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Null only for an existing plant reproduced by capacity (no boundary). */
  geometry: Polygon | null;
  exclusions: Polygon[];
  grid_point: number[] | null;
  cable_distance_m: number | null;
  water_depth_m: number | null;
  water_level_m: number | null;
  site_type: SiteType;
  reference_plant_id: string | null;
  source: string;
};
export type MappedCandidate = Candidate & { geometry: Polygon };
export const hasGeometry = (c: Candidate): c is MappedCandidate =>
  c.geometry != null;
export type Settings = Record<string, number | string>;
export type FinanceSettings = Record<string, number | string | number[]>;
export type Design = {
  id: string;
  project_id: string;
  candidate_id: string;
  name: string;
  updated_at?: string;
  equipment: Settings;
  costs: Settings;
  finance: FinanceSettings;
};
export type Project = {
  id: string;
  name: string;
  description: string;
  demo: boolean;
  candidate_count?: number;
  design_count?: number;
  last_analysis_at?: string;
  status?: string;
};
export type Economics = {
  capex: number;
  annual_opex: number;
  first_year_sales_kwh: number;
  first_year_revenue: number;
  pv_inflow: number;
  pv_outflow: number;
  npv: number;
  bc: number | null;
  irr_pct: number | null;
  payback_years: number | null;
  effective_price_per_kwh: number;
  required_price_per_kwh: number | null;
  cashflows: {
    year: number;
    generation_kwh: number;
    sales_kwh: number;
    self_use_kwh: number;
    revenue: number;
    opex: number;
    replacement: number;
    net: number;
    discounted_net: number;
    cumulative: number;
  }[];
};
export type ModelMetrics = {
  months: number;
  plants: number;
  mape_pct: number;
  bias_pct: number;
  rmse_pct: number;
  plant_total_abs_error_pct: number;
};
export type MonthRow = {
  month: number;
  energy_kwh: number;
  physics_kwh: number;
  calibrated_kwh?: number;
  p10_kwh?: number;
  p90_kwh?: number;
  ratio?: number;
  poa_kwh_m2: number;
  ghi_kwh_m2: number;
  temp_air: number;
};
export type CostItem = {
  key: string;
  label: string;
  amount: number;
  basis: string;
  source: string;
};
export type Result = {
  capacity_dc_kw: number;
  capacity_ac_kw: number;
  annual_kwh: number;
  specific_yield: number;
  capacity_factor_pct: number;
  daily_hours: number;
  energy_basis: "calibrated" | "physics";
  monthly: MonthRow[];
  physics: {
    annual_kwh: number;
    years: number[];
    annual_by_year: { year: number; energy_kwh: number }[];
  };
  calibration: {
    model: string;
    model_label: string;
    annual_kwh: number;
    annual_p10_kwh: number;
    annual_p90_kwh: number;
    annual_by_year: { year: number; energy_kwh: number }[];
    band_basis: string;
    band_plants: number;
    excluded_plant: string | null;
    validation: {
      label: string;
      all: ModelMetrics;
      floating: ModelMetrics | null;
    };
  } | null;
  steps: {
    site: {
      province: string;
      nearest_city: string;
      region_basis: string;
      optimal_tilt: number;
      tilt_basis: string;
      seasonal_tilts: Record<string, number>;
      seasonal_basis: string;
      azimuth_basis: string;
      wind_speed_ms: number;
      snow_load_kn_m2: number;
      seismic_zone: string;
      seismic_coeff_g: number;
      structural_basis: string;
      site_type: SiteType;
      structure_type: "fixed" | "seasonal";
      tilt: number;
      azimuth: number;
      tilt_mode: string;
      climate: {
        station: KmaStation;
        distance_km: number;
        period: string;
        analysis_years: string;
        months: {
          month: number;
          normal_ta: number | null;
          normal_ta_min: number | null;
          normal_sunshine_hours: number | null;
          reanalysis_ta: number | null;
        }[];
        annual_sunshine_normal: number;
        temperature_bias_c: number;
        coldest_normal_min_c: number;
        basis: string;
      } | null;
    };
    equipment: {
      module: {
        module_model: string;
        module_power_w: number;
        module_width_m: number;
        module_height_m: number;
        module_price: number;
      };
      area_m2: number | null;
      usable_area_m2: number | null;
      max_modules_by_area: number | null;
      requested_modules: number;
      module_count: number;
      pitch: {
        array_length_m: number;
        plan_depth_m: number;
        gap_m: number;
        pitch_m: number;
        basis: string;
      };
      strings: {
        series: number;
        parallel: number;
        series_min: number;
        series_max: number;
        string_voc_v: number;
        basis: string;
        warnings: string[];
      };
      inverter: {
        units: { kw: number; count: number; unit_cost: number }[];
        ac_capacity_kw: number;
        cost: number;
        rule: string;
        junction_boxes: { inverter_kw: number; channels: number; count: number }[];
        junction_box_count: number;
        basis: string;
      };
      grid: {
        voltage: string;
        network: string;
        voltage_variation_limit_pct: number | null;
      };
      purpose: "sale" | "self";
    };
    costs: {
      items: CostItem[];
      total: number;
      per_kw: number;
      annual_om: number;
      replacement_cost: number;
      replacement_year: number;
    };
    revenue: {
      purpose: "sale" | "self";
      price_per_kwh: number;
      first_year_revenue: number;
      first_year_sales_kwh: number;
      first_year_self_use_kwh: number;
    };
    substitution: {
      households: number;
      oil_toe: number;
      pine_trees: number;
      co2_t: number;
      basis: string;
    };
  };
  economics: Economics;
  stress: {
    label: string;
    factor: number;
    annual_kwh: number;
    bc: number | null;
    npv: number;
    irr_pct: number | null;
    required_price_per_kwh: number | null;
  }[];
  layout: {
    module_count: number;
    requested_count: number;
    area_m2: number;
    usable_area_m2: number;
    coverage_pct: number;
    modules: Polygon[];
    warnings: string[];
  } | null;
  reference?: {
    plant: Plant;
    model_label: string;
    rows: {
      year: number;
      month: number;
      measured_kwh: number;
      predicted_kwh: number;
      physics_kwh: number;
    }[];
    metrics: Record<string, { mape_pct: number; bias_pct: number; plant_total_abs_error_pct: number; months: number }>;
    note: string;
  } | null;
  cable_distance_m: number;
  connection_distance_basis: string;
  provenance: {
    model: string;
    version: string;
    weather_source: string;
    period: { start: string; end: string };
    interval_minutes: number;
    assumptions: string[];
    warnings: string[];
  };
};
export type Run = {
  id: string;
  design_id: string;
  project_id: string;
  status: "running" | "completed" | "failed" | "pending";
  created_at: string;
  snapshot: { project: Project; candidate: Candidate; design: Design };
  result: Result | null;
  error: string | null;
};
export type Workspace = {
  project: Project;
  candidates: Candidate[];
  designs: Design[];
  runs: Run[];
};
export type Catalog = {
  defaults: {
    equipment: Settings;
    costs: Settings;
    finance: FinanceSettings;
  };
  modules: {
    id: string;
    label: string;
    module_power_w: number;
    module_width_m: number;
    module_height_m: number;
    module_price: number;
    source: string;
  }[];
  guideline: string;
};
export type WaterBody = {
  id: string;
  name: string | null;
  kind: string;
  area_m2: number;
  latitude: number;
  longitude: number;
  geometry: Polygon;
};
export type WaterSearch = {
  results: WaterBody[];
  total: number;
  attribution: string;
  warning: string | null;
};
export type Plant = {
  id: string;
  name: string;
  type: SiteType | "unknown";
  type_label: string;
  capacity_kw: number;
  latitude: number;
  longitude: number;
  coordinate_basis: string;
  tilt: number;
  azimuth: number;
  orientation_basis: string;
  data_kind: "generation" | "settlement";
  source: string;
  months?: number;
  usable_months?: number;
  train_months?: number;
  availability_flagged?: number;
  outlier?: boolean;
  ratio?: number | null;
  zero_days?: number;
  spike_days?: number;
  first?: string;
  last?: string;
  specific_yield?: number | null;
};
export type PlantList = {
  plants: Plant[];
  qc: {
    spike_kwh_per_kwp: number;
    min_month_coverage: number;
    availability_factor: number;
    plant_outlier_factor: number;
  };
  weather_source: string;
};
export type PlantDetail = {
  plant: Plant;
  monthly: {
    year: number;
    month: number;
    days: number;
    valid_days: number;
    coverage: number;
    measured_kwh: number;
    physics_kwh: number;
    ratio: number | null;
    zero_days: number;
    spike_days: number;
    usable: boolean;
    availability_flag: boolean;
    train: boolean;
  }[];
  daily: {
    date: string;
    measured: number | null;
    physics: number | null;
    flag: "ok" | "zero" | "spike" | "missing";
  }[];
};
export type CalibrationSummary = {
  selected_model: string;
  selected_label: string;
  selection_rule: string;
  models: Record<
    string,
    {
      label: string;
      all: ModelMetrics;
      floating: ModelMetrics | null;
      non_floating: ModelMetrics | null;
    }
  >;
  per_plant: ({ model: string; plant_id: string; name: string } & ModelMetrics)[];
  band: {
    monthly: Record<string, { p10: number; p50: number; p90: number; n: number }>;
    annual: { p10: number; p50: number; p90: number; n_plants: number };
    basis: string;
  };
  dataset: {
    plants: number;
    plant_months: number;
    train_months: number;
    low_coverage_months: number;
    availability_flagged_months: number;
    outlier_plants: { plant_id: string; name: string; ratio: number; median_ratio: number }[];
    period: string;
  };
  weather_source: string;
  physics_reference: string;
};
export type PredictionRow = {
  model: string;
  plant_id: string;
  type: string;
  year: number;
  month: number;
  measured: number;
  physics: number;
  predicted: number;
};
export type KmaStation = {
  stn: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  coordinate_basis: string;
};
export type WeatherCheck = {
  irradiance: {
    station: KmaStation;
    days: number;
    period: string;
    daily_correlation: number;
    overall_ratio: number;
    daily_mape_pct: number;
    temperature_bias_c: number;
    factors: Record<string, number>;
    monthly: { month: string; observed_kwh_m2: number; reanalysis_kwh_m2: number }[];
    basis: string;
  } | null;
  applied: boolean;
  variants: Record<string, { score: number; label: string }> | null;
  rule: string | null;
  normals: {
    station: KmaStation;
    period: string;
    months: {
      month: number;
      ta: number | null;
      ta_max: number | null;
      ta_min: number | null;
      hm: number | null;
      ss_hours: number | null;
    }[];
  } | null;
  long_term_years: number[];
  weather_source: string;
};
