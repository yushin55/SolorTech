import type { Candidate, SiteType, WaterBody } from "./types";

export function solarTarget(candidate: Candidate | null | undefined, site: WaterBody | null,
  point: { latitude: number; longitude: number } | null, siteType: SiteType) {
  const position = site || point || candidate;
  if (!position) return null;
  const saved: Partial<Candidate> = candidate || {};
  const { name, geometry, exclusions, grid_point, cable_distance_m, water_depth_m, water_level_m,
    reference_plant_id, source, boundary_setback_m, terrain_slope_deg, slope_limit_deg, roof_mount,
    roof_tilt_deg, roof_azimuth_deg, roof_allowable_load_kg_m2, roof_system_load_kg_m2, solartech_asset_id } = saved;
  return { name: name || site?.name || "선택 위치", latitude: position.latitude, longitude: position.longitude,
    geometry: site?.geometry || geometry || null, site_type: candidate?.site_type || siteType,
    exclusions, grid_point, cable_distance_m, water_depth_m, water_level_m, reference_plant_id, source,
    boundary_setback_m, terrain_slope_deg, slope_limit_deg, roof_mount, roof_tilt_deg, roof_azimuth_deg,
    roof_allowable_load_kg_m2, roof_system_load_kg_m2, solartech_asset_id };
}
