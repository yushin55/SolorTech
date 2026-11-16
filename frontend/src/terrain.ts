import type { Candidate, Catalog, TerrainMode, Workspace } from "./types";

export const terrainOf = (candidate: Candidate): TerrainMode =>
  candidate.site_type === "floating" ? "floating" : "land";

export function workspaceForTerrain(workspace: Workspace, mode: TerrainMode): Workspace {
  const candidates = workspace.candidates.filter((candidate) => terrainOf(candidate) === mode);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const designs = workspace.designs.filter((design) => candidateIds.has(design.candidate_id));
  const designIds = new Set(designs.map((design) => design.id));
  return { ...workspace, candidates, designs, runs: workspace.runs.filter((run) =>
    designIds.has(run.design_id) && terrainOf(run.snapshot.candidate) === mode) };
}

/** Size a site found on the map from its mapped outline instead of a typed-in area. */
export function boundaryDefaults(values: Catalog["defaults"], useBoundary: boolean): Catalog["defaults"] {
  if (useBoundary) values.equipment.capacity_mode = "area";
  return values;
}

export function defaultsForSite(catalog: Catalog, kind: Candidate["site_type"]): Catalog["defaults"] {
  if (kind === "floating") return structuredClone(catalog.defaults);
  if (catalog.site_defaults?.[kind]) return structuredClone(catalog.site_defaults[kind]!);
  // Compatibility with an API started before site_defaults was added.
  const values = structuredClone(catalog.defaults);
  Object.assign(values.equipment, { module_preset: "land_480", module_model: "육상용 단결정 480 Wp",
    module_power_w: 480, module_width_m: 1.043, module_height_m: 2.275, module_price: 230400,
    energy_basis: "physics", capacity_mode: "area", area_use_pct: 70 });
  Object.assign(values.costs, { float_per_kw: 0, mooring_per_kw: 0, structure_per_kw: 300000, cable_per_m: 30000 });
  if (kind === "rooftop") {
    Object.assign(values.equipment, { tilt_mode: "manual", tilt: 10 });
    values.costs.civil = 0;
  }
  return values;
}
