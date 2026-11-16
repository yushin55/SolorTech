"""Verify local archive integration; optionally backtest one real plant/year.

The optional comparison is disposable and does not create projects or retrain
models. It assumes land installation and a kWh interpretation for verification.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import generation, solartech  # noqa: E402
from app.engine.analysis import run_analysis  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compare", action="store_true")
    args = parser.parse_args()
    registry = solartech.load_registry()
    catalog = registry["generation_catalog"]
    folder = solartech.DATA_PATH.parent
    data_root = Path(__file__).resolve().parents[2] / "data"
    for item in catalog["parsed_files"]:
        assert hashlib.sha256((data_root / item["raw_path"]).read_bytes()).hexdigest() == item["sha256"]
    observations = sum(len(generation.observations(s["id"], folder=folder)) for s in catalog["series"])
    assert observations == catalog["summary"]["daily_records"] + catalog["summary"]["monthly_records"]
    print(json.dumps({"hashes_verified": len(catalog["parsed_files"]), "unique_observations": observations,
                      "summary": catalog["summary"]}, ensure_ascii=False), flush=True)
    if args.compare:
        asset = next(a for a in registry["assets"] if a["name"] == "하동 화력4")
        values = solartech.AssetImport(site_type="land", latitude=asset["latitude"], longitude=asset["longitude"],
                                      capacity_kw=asset["capacity_kw"], module_power_w=asset["module_power_w"],
                                      tilt=asset["tilt_deg"], azimuth=180)
        candidate, design = solartech.review_inputs(asset, values, registry["source_file"])
        candidate["solartech_asset_id"] = asset["id"]
        snapshot = {"candidate": candidate, "design": design, "weather": {"years": [2025]}}
        result = run_analysis(snapshot)
        run = {"id": "disposable-generation-verification", "status": "completed", "snapshot": snapshot, "result": result}
        series = next(s for s in catalog["series"] if asset["id"] in s["asset_ids"])
        comparison = generation.compare(series, run, 2025, generation.observations(series["id"], 2025, folder))
        assert comparison["compatible"] and comparison["valid_rows"] > 300
        assert any(m["relative_error_pct"] is not None for m in comparison["monthly"])
        print(json.dumps({"plant": asset["name"], "year": 2025, "assumptions": ["육상 설치 가정", "kWh 해석 가정", "방위 180도 가정"],
                          "capacity_dc_kw": result["capacity_dc_kw"], "physics_kwh": result["annual_kwh"],
                          "source_records": comparison["row_count"], "valid_records": comparison["valid_rows"],
                          "compared_months": sum(m["relative_error_pct"] is not None for m in comparison["monthly"])}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
