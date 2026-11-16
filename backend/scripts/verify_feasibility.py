"""HTTP smoke test against an isolated QA server, using cached historical weather.

Start the server with a separate LOCAL_DB_PATH, then run this script. It creates
a clearly named QA project, leaving the immutable runs available for inspection.
"""
import argparse
import json
import math
from pathlib import Path
import time

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8001/api")
    args = parser.parse_args()
    with httpx.Client(base_url=args.base, timeout=120) as client:
        def request(method, path, data=None):
            response = client.request(method, path, json=data)
            response.raise_for_status()
            return response.json()

        def analyse(design_id):
            run = request("POST", f"/designs/{design_id}/runs")
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                run = request("GET", f"/runs/{run['id']}")
                if run["status"] == "failed":
                    raise RuntimeError(run["error"])
                if run["status"] == "completed":
                    return run
                time.sleep(.5)
            raise TimeoutError("analysis did not complete")

        projects = request("GET", "/projects")
        source_workspace = next(request("GET", f"/projects/{project['id']}/workspace") for project in projects if project.get("demo"))
        original = next(site for site in source_workspace["candidates"] if "예당" in site["name"])
        project = request("POST", "/projects", {"name": "신규 사업성 기능 HTTP QA", "description": "격리 QA DB · 실제 캐시 기상 기반 검증"})
        candidate = request("POST", f"/projects/{project['id']}/candidates", {
            "name": "좌표 기반 QA 후보지", "latitude": original["latitude"], "longitude": original["longitude"],
            "site_type": "land", "geometry": original["geometry"], "cable_distance_m": 200., "terrain_slope_deg": 0.,
        })
        selection = request("GET", f"/weather/nearest?latitude={candidate['latitude']}&longitude={candidate['longitude']}")
        defaults = request("GET", "/catalogs")["site_defaults"]["land"]
        defaults["equipment"].update(capacity_mode="target", target_capacity_kw=100., module_preset="hd_his_t650uj",
                                      tilt_mode="manual", tilt=30., azimuth=180.)
        defaults["finance"].update(fixed_price=-5., price_scenarios=[-10., 0., 150.])
        design = request("POST", f"/projects/{project['id']}/designs", {
            **defaults, "name": "목표 용량 100 kW", "candidate_id": candidate["id"]})
        run = analyse(design["id"])
        result = run["result"]
        assert result["capacity_dc_kw"] >= 100
        assert result["sizing"]["minimum_modules"] == math.ceil(100000 / 650)
        assert result["economics"]["first_year_revenue"] == -5 * result["economics"]["first_year_sales_kwh"]
        assert abs(sum(row["revenue"] for row in result["revenue_monthly"]) - result["economics"]["first_year_revenue"]) < .01
        assert result["weather_station"]["selected"]["stn"] == selection["selected"]["stn"]
        assert result["weather_station"]["applied_factors"]
        assert len(result["orientation_comparison"]) == 5
        assert not {"float", "mooring"} & {row["key"] for row in result["steps"]["costs"]["items"]}
        exported = client.get(f"/runs/{run['id']}/csv")
        exported.raise_for_status()
        assert "forecast_monthly_revenue" in exported.text and "source_or_basis" in exported.text
        target_summary = {"run_id": run["id"], "capacity_kw": result["capacity_dc_kw"],
                          "modules": result["steps"]["equipment"]["module_count"], "annual_kwh": result["annual_kwh"],
                          "annual_revenue": result["economics"]["first_year_revenue"]}

        request("PATCH", f"/candidates/{candidate['id']}", {"site_type": "floating"})
        request("PATCH", f"/designs/{design['id']}", {
            "equipment": {"capacity_mode": "area_input", "site_area_m2": 10000., "reserve_pct": 30.},
            "costs": {"float_per_kw": 300000., "mooring_per_kw": 160000.}, "finance": {"fixed_price": 150.}})
        area_run = analyse(design["id"])
        area = area_run["result"]
        assert {"float", "mooring"} <= {row["key"] for row in area["steps"]["costs"]["items"]}
        assert area["sizing"]["site_area_m2"] == 10000
        assert area["sizing"]["reserve_pct"] == 30
        assert area["capacity_dc_kw"] == area["sizing"]["capacity_kw"]
        saved = request("GET", f"/runs/{run['id']}")
        assert saved["snapshot"]["candidate"]["site_type"] == "land"
        assert saved["snapshot"]["design"]["finance"]["fixed_price"] == -5
        report = {"status": "passed", "weather": "Actual cached ERA5 1991–2020 + KMA monthly observation profile (demo)",
                  "target": target_summary, "area": {"run_id": area_run["id"], "capacity_kw": area["capacity_dc_kw"],
                                                        "modules": area["steps"]["equipment"]["module_count"]},
                  "nearest_station": selection["nearest"]["name"], "connected_station": selection["selected"]["name"],
                  "distance_km": selection["selected"]["distance_km"], "csv_assumptions": "passed",
                  "snapshot_immutability": "passed", "browser_visual_check": "not performed: browser URL unavailable"}
        output = Path(__file__).resolve().parents[2] / "docs" / "feasibility-http-verification.json"
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    main()
