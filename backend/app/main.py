import base64
import math
import copy
import csv
import io
import json
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError

from . import calibration, generation, kma, kwater, solartech, stations, weather
from .engine import catalog, siting, guideline
from .geocoding import search_places
from .legacy_data import readable
from .seed import seed_candidates
from .sitefinder import find_sites
from .waterbodies import find_water_bodies
from .schemas import CandidateCreate, DesignCreate, Equipment, ProjectCreate, ProjectPatch, defaults
from .store import create_repository
from .validation import MAX_BYTES, parse_timestamp, read_csv, validate_measurements

logger = logging.getLogger(__name__)


def isnan(value):
    return value is None or (isinstance(value, float) and math.isnan(value))
VERSION = "2.0.0"


def now():
    return datetime.now(timezone.utc).isoformat()


def new_id():
    return uuid.uuid4().hex


def record(payload, **extra):
    return {**payload, "id": new_id(), "created_at": now(), "updated_at": now(), **extra}


def find(repo, kind, identifier):
    item = repo.get(kind, identifier)
    if item is None:
        raise HTTPException(404, "자료를 찾을 수 없습니다.")
    return readable(kind, item)


def project_summary(repo, project):
    candidates = [item for item in repo.list("candidates") if item["project_id"] == project["id"]]
    designs = [item for item in repo.list("designs") if item["project_id"] == project["id"]]
    runs = [item for item in repo.list("runs") if item["project_id"] == project["id"]]
    latest = max(runs, key=lambda item: item["created_at"], default=None)
    return {**project, "candidate_count": len(candidates), "design_count": len(designs), "run_count": len(runs),
            "last_run_at": latest["created_at"] if latest else None, "last_run_status": latest["status"] if latest else None,
            "last_analysis_at": latest["created_at"] if latest else None, "status": latest["status"] if latest else "pending"}


def add_project(repo, payload):
    project = record(payload)
    repo.put("projects", project)
    if payload.get("demo"):
        for payload_candidate, designs in seed_candidates():
            candidate = record(payload_candidate, project_id=project["id"], demo=True)
            repo.put("candidates", candidate)
            for payload_design in designs:
                repo.put("designs", record({**payload_design, "candidate_id": candidate["id"]}, project_id=project["id"]))
    return project


def migrate_v2(repo):
    """Drop the v1 synthetic demo sites and synthetic-weather runs; upgrade the rest.

    v1 runs were computed on generated weather, so none are kept. User-made
    candidates are kept and get v2 fields; their designs keep name and module
    count and otherwise take v2 defaults (the old cost model no longer applies).
    """
    if repo.get("meta", "schema_v2"):
        return
    for run in repo.list("runs"):
        delete_run(repo, run["id"])
    for candidate in repo.list("candidates"):
        if candidate.get("demo"):
            delete_candidate(repo, candidate["id"])
            continue
        candidate.setdefault("site_type", "floating")
        candidate.setdefault("reference_plant_id", None)
        candidate.setdefault("source", "")
        repo.put("candidates", candidate)
    fresh = defaults()
    for design in repo.list("designs"):
        upgraded = {**design, **copy.deepcopy(fresh)}
        upgraded.pop("sensitivity", None)
        count = design.get("equipment", {}).get("module_count")
        if isinstance(count, int) and count > 0:
            upgraded["equipment"]["module_count"] = count
        repo.put("designs", upgraded)
    for project in repo.list("projects"):
        if project.get("demo"):
            project.update(demo=False, name=project["name"].replace(" · 합성자료 데모", ""),
                           description="", updated_at=now())
            repo.put("projects", project)
    repo.put("meta", {"id": "schema_v2", "created_at": now()})


def with_defaults(design):
    """Fill input fields added after a design was saved (e.g. PF 융자) with today's defaults for display."""
    base = defaults()
    return {**design, **{group: {**base[group], **(design.get(group) or {})} for group in ("equipment", "costs", "finance")}}


def touch(repo, project_id):
    project = repo.get("projects", project_id)
    if project:
        project["updated_at"] = now()
        repo.put("projects", project)


def delete_run(repo, identifier):
    for kind in ("validation_uploads", "validation_processed"):
        for item in repo.list(kind):
            if item["run_id"] == identifier:
                repo.delete(kind, item["id"])
    repo.delete("runs", identifier)


def delete_design(repo, identifier):
    for run in repo.list("runs"):
        if run["design_id"] == identifier:
            delete_run(repo, run["id"])
    repo.delete("designs", identifier)


def delete_candidate(repo, identifier):
    for design in repo.list("designs"):
        if design["candidate_id"] == identifier:
            delete_design(repo, design["id"])
    repo.delete("candidates", identifier)


def checked(schema, payload):
    try:
        return schema.model_validate(payload).model_dump()
    except ValidationError as error:
        raise HTTPException(422, error.errors(include_context=False, include_url=False, include_input=False)) from error


def input_only(item, model):
    return {key: value for key, value in item.items() if key in model.model_fields}


def editable_patch(item, payload, model):
    """Accept round-tripped records while refusing changes to generated fields."""
    result = dict(payload)
    for key in set(result)-set(model.model_fields):
        if key in item:
            if result[key] != item[key]:
                raise HTTPException(422, f"{key} 항목은 변경할 수 없습니다.")
            result.pop(key)
    return result


def measured_period_model(run, rows, mapping):
    """Simulate the run's design on the reanalysis weather of the uploaded dates."""
    from .engine.analysis import period_model_rows

    column = mapping.get("timestamp")
    years = set()
    for row in rows:
        try:
            years.add(parse_timestamp(row.get(column)).year)
        except (ValueError, TypeError):
            continue
    if not years:
        raise ValueError("유효한 시각이 없어 비교 기간을 정할 수 없습니다.")
    if len(years) > 5:
        raise ValueError("한 번에 5개 연도 이내의 실적만 비교할 수 있습니다.")
    return period_model_rows(run, sorted(years))


def execute_run(repo, identifier, snapshot):
    try:
        from .engine import run_analysis

        result = run_analysis(copy.deepcopy(snapshot))
        json.dumps(result, allow_nan=False)
        run = repo.get("runs", identifier)
        if run:
            run.update(status="completed", result=result, updated_at=now(), completed_at=now())
            repo.put("runs", run)
    except Exception as error:
        logger.exception("Analysis failed: %s", identifier)
        run = repo.get("runs", identifier)
        if run:
            # Keep errors useful without returning server credential paths or full tracebacks.
            message = str(error) if isinstance(error, ValueError) else "분석 중 오류가 발생했습니다. 입력 조건과 서버 로그를 확인하세요."
            run.update(status="failed", error=message[:1500], updated_at=now(), completed_at=now())
            repo.put("runs", run)


def create_app(repository=None, seed=None):
    @asynccontextmanager
    async def lifespan(app):
        repo = repository or create_repository()
        app.state.repo = repo
        app.state.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="solar-analysis")
        for run in repo.list("runs"):
            if run["status"] == "running":
                run.update(status="failed", error="서버 재시작으로 분석이 중단되었습니다. 다시 실행하세요.", updated_at=now())
                repo.put("runs", run)
        migrate_v2(repo)
        do_seed = seed if seed is not None else os.getenv("SEED_DEMO", "true").lower() == "true"
        if do_seed and not repo.get("meta", "kwater_seeded"):
            add_project(repo, {"name": "K-water 실적 기반 태양광 검토", "description": "OSM 수면 경계(예당저수지·탑정호)와 아산정수장 운영실적 재현 검토. 기상은 ERA5 재분석 관측 이력입니다.", "demo": True})
            repo.put("meta", {"id": "kwater_seeded", "created_at": now()})
        yield
        app.state.executor.shutdown(wait=True)
        if repository is None:
            repo.close()

    app = FastAPI(title="태양광 사업 검토 API", version=VERSION, lifespan=lifespan)
    @app.exception_handler(RequestValidationError)
    async def request_validation_error(request, error):
        # Invalid NaN/Infinity input must still yield a valid JSON error response.
        detail = [{key: item[key] for key in ("type", "loc", "msg") if key in item} for item in error.errors()]
        return JSONResponse(status_code=422, content={"detail": detail})

    origins = os.getenv("CORS_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174,http://localhost:5173,http://127.0.0.1:5173").split(",")
    app.add_middleware(CORSMiddleware, allow_origins=[item.strip() for item in origins],
                       allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type"])

    @app.get("/api/health")
    def health(request: Request):
        result = calibration.load_result()
        return {"status": "ok", "storage": request.app.state.repo.storage, "version": VERSION,
                "timezone": "Asia/Seoul", "mode": "local-single-user", "authentication": False,
                "weather": weather.SOURCE, "weather_years": weather.long_term_years(),
                "plants": len(kwater.load_registry()),
                "calibration": result["selected_label"] if result else None,
                "irradiance_correction": bool(((result or {}).get("weather_correction") or {}).get("applied"))}

    @app.get("/api/catalogs")
    def catalogs():
        values = defaults()
        return {"modules": [{"id": key, **value} for key, value in guideline.MODULES.items()],
                "inverters": [{"id": key, **value} for key, value in catalog.INVERTERS.items()],
                "inverter_units": [{"kw": kw, "unit_cost": cost, "junction": guideline.JUNCTION[kw]}
                                   for kw, cost in guideline.INVERTER_UNITS.items()],
                "string_example": guideline.STRING_EXAMPLE, "guideline": guideline.SOURCE, "defaults": values}

    @app.get("/api/guideline/site")
    def guideline_site(latitude: float = Query(..., ge=33, le=39), longitude: float = Query(..., ge=124, le=132)):
        nearby = stations.nearest(latitude, longitude, 3)
        checks = {stn: {"station": kma.station(stn), "factors": {}} for stn in kma.irradiance_stations()}
        near_si = kma.nearest_correction(latitude, longitude, checks)
        if near_si:
            near_si.pop("factors", None)
        return {**guideline.site_factors(latitude, longitude), "weather_station": nearby[0],
                "nearby_stations": nearby, "station_source": stations.SOURCE,
                "irradiance_station": near_si}

    @app.get("/api/weather-stations")
    def weather_stations():
        return {"stations": stations.STATIONS, "source": stations.SOURCE}

    @app.post("/api/capacity-preview")
    def capacity_preview(payload: dict = Body(...)):
        """Live module count / capacity for the design form, same rules as the analysis."""
        from .engine.analysis import capacity_plan, design_strings

        try:
            latitude = float(payload.get("latitude"))
            longitude = float(payload.get("longitude"))
            equipment = Equipment.model_validate(payload.get("equipment") or {}).model_dump()
        except ValidationError as exc:
            fields = ", ".join(str(err["loc"][-1]) for err in exc.errors()[:3])
            raise HTTPException(422, f"입력값을 확인하세요 (빈 칸이거나 범위를 벗어난 값: {fields})") from exc
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, "후보지 좌표가 필요합니다.") from exc
        if not (33 <= latitude <= 39 and 124 <= longitude <= 132):
            raise HTTPException(422, "국내 좌표만 계산할 수 있습니다.")
        factors = guideline.site_factors(latitude, longitude)
        site = payload.get("site") if isinstance(payload.get("site"), dict) else {}
        try:
            resolved, pitch, _ = siting.resolve({"latitude": latitude, "longitude": longitude, **site}, equipment, factors)
            plan = capacity_plan(resolved, pitch)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        try:
            strings = design_strings(plan, resolved)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        used = strings["modules_used"]
        return {**plan, "modules_used": used, "dc_kw": used * resolved["module_power_w"] / 1000,
                "tilt": resolved["tilt"], "azimuth": resolved["azimuth"], "string_warnings": strings["warnings"],
                "module": {key: resolved.get(key) for key in ("module_model", "module_manufacturer", "module_power_w",
                                                              "module_width_m", "module_height_m", "module_source")}}

    @app.get("/api/plants")
    def plants():
        months = calibration.load_months()
        summary = {}
        if months is not None:
            for plant_id, rows in months.groupby("plant_id"):
                usable = rows[rows.usable.astype(bool)]
                summary[plant_id] = {
                    "months": int(len(rows)), "usable_months": int(len(usable)),
                    "train_months": int(rows.train.astype(bool).sum()),
                    "availability_flagged": int(rows.availability_flag.astype(bool).sum()),
                    "outlier": bool(rows.plant_outlier.astype(bool).any()),
                    "ratio": None if rows.plant_ratio.isna().all() else float(rows.plant_ratio.iloc[0]),
                    "zero_days": int(rows.zero_days.sum()), "spike_days": int(rows.spike_days.sum()),
                    "first": f"{int(rows.year.iloc[0])}-{int(rows.month.iloc[0]):02d}",
                    "last": f"{int(rows.year.iloc[-1])}-{int(rows.month.iloc[-1]):02d}",
                    "specific_yield": float(usable.measured.sum() / usable.valid_days.sum() * 365) if len(usable) else None,
                }
        return {"plants": [{**plant, **summary.get(plant["id"], {})} for plant in kwater.load_registry()],
                "qc": {"spike_kwh_per_kwp": kwater.SPIKE_KWH_PER_KWP, "min_month_coverage": kwater.MIN_MONTH_COVERAGE,
                       "availability_factor": calibration.AVAILABILITY_FACTOR,
                       "plant_outlier_factor": calibration.PLANT_OUTLIER_FACTOR},
                "weather_source": weather.SOURCE}

    @app.get("/api/plants/{identifier}")
    def plant_detail(identifier: str):
        plant = kwater.plant(identifier)
        if plant is None:
            raise HTTPException(404, "발전소를 찾을 수 없습니다.")
        months = calibration.load_months()
        days = calibration.load_daily_model()
        capacity = plant["capacity_kw"]
        monthly = []
        if months is not None:
            for row in months[months.plant_id == identifier].itertuples():
                monthly.append({"year": int(row.year), "month": int(row.month), "days": int(row.days),
                                "valid_days": int(row.valid_days), "coverage": float(row.coverage),
                                "measured_kwh": float(row.measured) * capacity, "physics_kwh": float(row.physics) * capacity,
                                "ratio": None if isnan(row.ratio) else float(row.ratio),
                                "zero_days": int(row.zero_days), "spike_days": int(row.spike_days),
                                "usable": bool(row.usable), "availability_flag": bool(row.availability_flag),
                                "train": bool(row.train)})
        daily = []
        if days is not None:
            for row in days[days.plant_id == identifier].itertuples():
                daily.append({"date": row.date,
                              "measured": None if isnan(row.measured_kwh_per_kwp) else float(row.measured_kwh_per_kwp),
                              "physics": None if isnan(row.physics_kwh_per_kwp) else float(row.physics_kwh_per_kwp),
                              "flag": row.flag})
        return {"plant": plant, "monthly": monthly, "daily": daily}

    @app.get("/api/calibration")
    def calibration_summary():
        result = calibration.load_result()
        if result is None:
            raise HTTPException(404, "보정 결과가 없습니다. scripts/build_calibration.py를 실행하세요.")
        return {key: value for key, value in result.items() if key != "predictions"}

    @app.get("/api/weather-check")
    def weather_check():
        result = calibration.load_result() or {}
        correction = result.get("weather_correction") or {}
        normals = kma.load_normals()
        return {"irradiance": correction.get("check"), "applied": bool(correction.get("applied")),
                "mode": correction.get("mode"), "selected": correction.get("selected"),
                "stations": [{"stn": int(stn), **{k: v for k, v in info.items() if k != "factors"},
                              "factors": info.get("factors")}
                             for stn, info in (correction.get("station_factors") or {}).items()],
                "variants": correction.get("variants"), "rule": correction.get("rule"),
                "normals": None if normals is None else {
                    "station": kma.station(int(normals.stn.iloc[0])), "period": str(normals.period.iloc[0]),
                    # Missing normals (e.g. cloud cover −99.9) are NaN in pandas; JSON needs null.
                    "months": normals.sort_values("month").astype(object).where(normals.notna(), None).to_dict("records")},
                "long_term_years": weather.long_term_years(), "weather_source": weather.SOURCE}

    @app.get("/api/calibration/predictions")
    def calibration_predictions(plant_id: str = Query(..., max_length=100)):
        result = calibration.load_result()
        if result is None:
            raise HTTPException(404, "보정 결과가 없습니다.")
        return [row for row in result["predictions"] if row["plant_id"] == plant_id]

    @app.get("/api/geocoding/search")
    def geocoding_search(q: str = Query(..., min_length=2, max_length=120)):
        try:
            return search_places(q)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get("/api/solartech/assets")
    def solartech_assets():
        return solartech.load_registry()

    @app.get("/api/solartech/generation/{series_id}")
    def generation_records(series_id: str, year: int = Query(..., ge=1900, le=2200)):
        data = generation.catalog(solartech.DATA_PATH.parent)
        series = next((s for s in (data or {}).get("series", []) if s["id"] == series_id), None)
        if series is None:
            raise HTTPException(404, "발전실적을 찾을 수 없습니다.")
        return {"series": series, "year": year, "records": generation.observations(series_id, year, solartech.DATA_PATH.parent)}

    @app.post("/api/solartech/generation/{series_id}/compare")
    def compare_generation(series_id: str, request: Request, payload: dict = Body(...)):
        if payload.get("assume_kwh") is not True:
            raise HTTPException(422, "원본 단위의 kWh 해석 가정을 확인해야 대조할 수 있습니다.")
        year = payload.get("year")
        if isinstance(year, bool) or not isinstance(year, int) or not 1900 <= year <= 2200:
            raise HTTPException(422, "대조 연도를 확인하세요.")
        run_id = payload.get("run_id")
        if not isinstance(run_id, str):
            raise HTTPException(422, "완료된 분석을 선택하세요.")
        run = find(request.app.state.repo, "runs", run_id)
        if run["status"] != "completed":
            raise HTTPException(409, "완료된 분석을 선택하세요.")
        data = generation.catalog(solartech.DATA_PATH.parent)
        series = next((s for s in (data or {}).get("series", []) if s["id"] == series_id), None)
        if series is None:
            raise HTTPException(404, "발전실적을 찾을 수 없습니다.")
        try:
            return generation.compare(series, run, year, generation.observations(series_id, year, solartech.DATA_PATH.parent))
        except ConnectionError as error:
            raise HTTPException(502, str(error)) from error
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/projects/{identifier}/solartech-assets/{asset_id}", status_code=201)
    def import_solartech_asset(identifier: str, asset_id: str, payload: solartech.AssetImport, request: Request):
        repo = request.app.state.repo
        find(repo, "projects", identifier)
        registry = solartech.load_registry()
        asset = next((a for a in registry["assets"] if a["id"] == asset_id), None)
        if asset is None:
            raise HTTPException(404, "엑셀 발전소 정보를 찾을 수 없습니다.")
        # A repeated click must not create another candidate or overwrite edits.
        with repo.lock:
            existing = next((c for c in repo.list("candidates") if c["project_id"] == identifier and c.get("solartech_asset_id") == asset_id), None)
            if existing:
                existing_design = next((d for d in repo.list("designs") if d["candidate_id"] == existing["id"]), None)
                return {"candidate": existing, "design": existing_design, "already_imported": True}
            candidate_input, design_input = solartech.review_inputs(asset, payload, registry["source_file"])
            try:
                from .engine.analysis import capacity_plan
                factors = guideline.site_factors(candidate_input["latitude"], candidate_input["longitude"])
                resolved, pitch, _ = siting.resolve(candidate_input, design_input["equipment"], factors)
                capacity_plan(resolved, pitch)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            candidate = record(candidate_input, project_id=identifier, demo=False, solartech_asset_id=asset_id,
                               solartech_source={"file": registry["source_file"], "sha256": registry["sha256"], "asset": asset,
                                                 "confirmed_inputs": payload.model_dump()})
            design_input["candidate_id"] = candidate["id"]
            design = record(design_input, project_id=identifier)
            repo.put("candidates", candidate)
            try:
                repo.put("designs", design)
            except Exception:
                repo.delete("candidates", candidate["id"])
                raise
            touch(repo, identifier)
        return {"candidate": candidate, "design": design, "already_imported": False}

    @app.get("/api/water-bodies")
    def water_bodies(west: float, south: float, east: float, north: float):
        try:
            return find_water_bodies(west, south, east, north)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except PermissionError as error:
            raise HTTPException(503, str(error)) from error
        except ConnectionError as error:
            raise HTTPException(502, str(error)) from error

    @app.get("/api/site-candidates")
    def site_candidates(kind: str, west: float, south: float, east: float, north: float):
        try:
            return find_sites(kind, west, south, east, north)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except PermissionError as error:
            raise HTTPException(503, str(error)) from error
        except ConnectionError as error:
            raise HTTPException(502, str(error)) from error

    @app.get("/api/projects")
    def projects(request: Request):
        repo = request.app.state.repo
        return sorted([project_summary(repo, item) for item in repo.list("projects")], key=lambda item: item["updated_at"], reverse=True)

    @app.post("/api/projects", status_code=201)
    def create_project(payload: ProjectCreate, request: Request):
        repo = request.app.state.repo
        return project_summary(repo, add_project(repo, payload.model_dump()))

    @app.patch("/api/projects/{identifier}")
    def patch_project(identifier: str, payload: ProjectPatch, request: Request):
        repo = request.app.state.repo
        project = find(repo, "projects", identifier)
        updated = payload.model_dump(exclude_unset=True)
        checked(ProjectCreate, {**input_only(project, ProjectCreate), **updated})
        project.update(updated, updated_at=now())
        repo.put("projects", project)
        return project_summary(repo, project)

    @app.delete("/api/projects/{identifier}", status_code=204)
    def remove_project(identifier: str, request: Request):
        repo = request.app.state.repo
        find(repo, "projects", identifier)
        for candidate in repo.list("candidates"):
            if candidate["project_id"] == identifier:
                delete_candidate(repo, candidate["id"])
        repo.delete("projects", identifier)
        return Response(status_code=204)

    @app.post("/api/projects/{identifier}/duplicate", status_code=201)
    def duplicate_project(identifier: str, request: Request):
        repo = request.app.state.repo
        original = find(repo, "projects", identifier)
        project = record(input_only(original, ProjectCreate), source_project_id=identifier)
        project["name"] = original["name"][:114] + " · 복제"
        repo.put("projects", project)
        candidate_ids, design_ids = {}, {}
        for candidate in repo.list("candidates"):
            if candidate["project_id"] == identifier:
                clone = record(input_only(candidate, CandidateCreate), project_id=project["id"], demo=candidate.get("demo", False))
                candidate_ids[candidate["id"]] = clone["id"]
                repo.put("candidates", clone)
        for design in repo.list("designs"):
            if design["project_id"] == identifier:
                payload = input_only(design, DesignCreate)
                payload["candidate_id"] = candidate_ids[design["candidate_id"]]
                clone = record(payload, project_id=project["id"])
                design_ids[design["id"]] = clone["id"]
                repo.put("designs", clone)
        for run in repo.list("runs"):
            if run["project_id"] == identifier:
                clone = copy.deepcopy(run)
                clone.update(id=new_id(), project_id=project["id"], design_id=design_ids[run["design_id"]], source_run_id=run["id"], created_at=now(), updated_at=now())
                # A copied immutable run retains the exact source snapshot for auditability.
                if clone["status"] == "running":
                    clone.update(status="failed", error="실행 중인 분석은 복제할 수 없습니다. 새 실행을 시작하세요.")
                repo.put("runs", clone)
        return project_summary(repo, project)

    @app.get("/api/projects/{identifier}/workspace")
    def workspace(identifier: str, request: Request):
        repo = request.app.state.repo
        project = find(repo, "projects", identifier)
        runs = []
        for run in repo.list("runs"):
            if run["project_id"] != identifier:
                continue
            summary = dict(run)
            if summary.get("result"):
                summary["result"] = {key: value for key, value in summary["result"].items() if key != "hourly"}
                if summary["result"].get("layout"):
                    summary["result"]["layout"] = {key: value for key, value in summary["result"]["layout"].items()
                                                   if key != "modules"}
            runs.append(summary)
        return {"project": project_summary(repo, project),
                "candidates": [readable("candidates", item) for item in repo.list("candidates") if item["project_id"] == identifier],
                "designs": [with_defaults(readable("designs", item)) for item in repo.list("designs") if item["project_id"] == identifier], "runs": runs}

    @app.post("/api/projects/{identifier}/candidates", status_code=201)
    def create_candidate(identifier: str, payload: CandidateCreate, request: Request):
        repo = request.app.state.repo
        find(repo, "projects", identifier)
        candidate = record(payload.model_dump(), project_id=identifier, demo=False)
        repo.put("candidates", candidate)
        touch(repo, identifier)
        return candidate

    @app.patch("/api/candidates/{identifier}")
    def patch_candidate(identifier: str, request: Request, payload: dict = Body(...)):
        repo = request.app.state.repo
        candidate = find(repo, "candidates", identifier)
        payload = editable_patch(candidate, payload, CandidateCreate)
        updated = checked(CandidateCreate, {**input_only(candidate, CandidateCreate), **payload})
        candidate.update(updated, updated_at=now())
        repo.put("candidates", candidate)
        touch(repo, candidate["project_id"])
        return candidate

    @app.delete("/api/candidates/{identifier}", status_code=204)
    def remove_candidate(identifier: str, request: Request):
        repo = request.app.state.repo
        candidate = find(repo, "candidates", identifier)
        delete_candidate(repo, identifier)
        touch(repo, candidate["project_id"])
        return Response(status_code=204)

    @app.post("/api/projects/{identifier}/designs", status_code=201)
    def create_design(identifier: str, payload: DesignCreate, request: Request):
        repo = request.app.state.repo
        find(repo, "projects", identifier)
        candidate = find(repo, "candidates", payload.candidate_id)
        if candidate["project_id"] != identifier:
            raise HTTPException(422, "다른 프로젝트의 후보지를 연결할 수 없습니다.")
        design = record(payload.model_dump(), project_id=identifier)
        repo.put("designs", design)
        touch(repo, identifier)
        return design

    @app.patch("/api/designs/{identifier}")
    def patch_design(identifier: str, request: Request, payload: dict = Body(...)):
        repo = request.app.state.repo
        design = find(repo, "designs", identifier)
        payload = editable_patch(design, payload, DesignCreate)
        original = input_only(design, DesignCreate)
        for key in ("equipment", "costs", "finance"):
            if isinstance(payload.get(key), dict):
                payload[key] = {**original[key], **payload[key]}
        updated = checked(DesignCreate, {**original, **payload})
        candidate = find(repo, "candidates", updated["candidate_id"])
        if candidate["project_id"] != design["project_id"]:
            raise HTTPException(422, "다른 프로젝트의 후보지를 연결할 수 없습니다.")
        design.update(updated, updated_at=now())
        repo.put("designs", design)
        touch(repo, design["project_id"])
        return design

    @app.delete("/api/designs/{identifier}", status_code=204)
    def remove_design(identifier: str, request: Request):
        repo = request.app.state.repo
        design = find(repo, "designs", identifier)
        delete_design(repo, identifier)
        touch(repo, design["project_id"])
        return Response(status_code=204)

    @app.post("/api/designs/{identifier}/duplicate", status_code=201)
    def duplicate_design(identifier: str, request: Request):
        repo = request.app.state.repo
        original = find(repo, "designs", identifier)
        design = record(input_only(original, DesignCreate), project_id=original["project_id"], source_design_id=identifier)
        design["name"] = original["name"][:114] + " · 복제"
        repo.put("designs", design)
        touch(repo, original["project_id"])
        return design

    @app.post("/api/designs/{identifier}/runs", status_code=202)
    def start_run(identifier: str, request: Request):
        repo = request.app.state.repo
        design = find(repo, "designs", identifier)
        project = find(repo, "projects", design["project_id"])
        candidate = find(repo, "candidates", design["candidate_id"])
        running = [item for item in repo.list("runs") if item["status"] == "running"]
        if len(running) >= 8:
            raise HTTPException(429, "분석 대기열이 가득 찼습니다. 잠시 후 다시 실행하세요.")
        snapshot = copy.deepcopy({"project": project, "candidate": candidate, "design": design,
                                   "engine_version": VERSION,
                                   "weather": {"source": weather.SOURCE, "years": weather.long_term_years()}})
        run = record({"project_id": project["id"], "design_id": identifier, "status": "running", "snapshot": snapshot, "result": None, "error": None})
        repo.put("runs", run)
        request.app.state.executor.submit(execute_run, repo, run["id"], snapshot)
        touch(repo, project["id"])
        return {key: value for key, value in run.items() if key not in {"snapshot", "result"}}

    @app.get("/api/runs/{identifier}")
    def get_run(identifier: str, request: Request):
        return find(request.app.state.repo, "runs", identifier)

    @app.get("/api/runs/{identifier}/csv")
    def run_csv(identifier: str, request: Request):
        run = find(request.app.state.repo, "runs", identifier)
        if run["status"] != "completed":
            raise HTTPException(409, "완료된 분석만 다운로드할 수 있습니다.")
        result = run["result"]
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(["section", "month_or_metric", "value", "unit"])
        for row in result["monthly"]:
            writer.writerow(["generation", row["month"], row["energy_kwh"], "kWh"])
            writer.writerow(["generation_physics", row["month"], row["physics_kwh"], "kWh"])
            if "p10_kwh" in row:
                writer.writerow(["generation_p10", row["month"], row["p10_kwh"], "kWh"])
                writer.writerow(["generation_p90", row["month"], row["p90_kwh"], "kWh"])
        units = {"capacity_dc_kw": "kW", "capacity_ac_kw": "kW", "annual_kwh": "kWh", "specific_yield": "kWh/kW",
                 "capacity_factor_pct": "%", "energy_basis": ""}
        for key, unit in units.items():
            writer.writerow(["summary", key, result.get(key), unit])
        for item in result["steps"]["costs"]["items"]:
            writer.writerow(["capex", item["label"], item["amount"], "KRW"])
        for key, value in result["economics"].items():
            if not isinstance(value, (list, dict)):
                writer.writerow(["economics", key, value, ""])
        cashflows = result["economics"].get("cashflows", [])
        if cashflows:
            columns = list(cashflows[0])
            writer.writerow([])
            writer.writerow(["cashflow", *columns])
            for row in cashflows:
                writer.writerow(["cashflow", *(row.get(column) for column in columns)])
        writer.writerow([])
        writer.writerow(["run_id", identifier])
        writer.writerow(["engine_version", run["snapshot"]["engine_version"]])
        provenance = result["provenance"]
        writer.writerow(["weather", provenance["weather_source"], f"{provenance['period']['start']} ~ {provenance['period']['end']}"])
        return Response("\ufeff" + stream.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="solar-{identifier}.csv"'})

    async def uploaded(file):
        if not file.filename or not file.filename.lower().endswith(".csv"):
            raise HTTPException(422, "CSV 확장자 파일을 선택하세요.")
        content = await file.read(MAX_BYTES + 1)
        try:
            headers, rows, encoding = read_csv(content)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return content, headers, rows, encoding

    @app.post("/api/validation/preview")
    async def preview(file: UploadFile = File(...)):
        _, headers, rows, encoding = await uploaded(file)
        return {"headers": headers, "rows": rows[:10], "row_count": len(rows), "encoding": encoding,
                "timezone": "Asia/Seoul", "max_bytes": MAX_BYTES}

    @app.post("/api/validation", status_code=201)
    async def validation(request: Request, file: UploadFile = File(...), mapping: str = Form(...), run_id: str = Form(...),
                         kind: str = Form("generation"), measurement: str = Form("interval"), unit: str = Form("kWh"),
                         timestamp_semantics: str = Form("start"), interval_minutes: int = Form(60)):
        repo = request.app.state.repo
        run = find(repo, "runs", run_id)
        if run["status"] != "completed":
            raise HTTPException(409, "완료된 분석 실행을 선택하세요.")
        content, _, rows, encoding = await uploaded(file)
        try:
            column_mapping = json.loads(mapping)
            model_rows = None
            if "hourly" not in (run.get("result") or {}):
                model_rows = await run_in_threadpool(measured_period_model, run, rows, column_mapping)
            result = validate_measurements(rows, column_mapping, run, kind, measurement, unit, timestamp_semantics,
                                           interval_minutes, model_rows)
        except ConnectionError as error:
            raise HTTPException(502, str(error)) from error
        except (ValueError, TypeError) as error:
            raise HTTPException(422, str(error)) from error
        upload = record({"run_id": run_id, "project_id": run["project_id"], "filename": os.path.basename(file.filename.replace("\\", "/")),
                         "encoding": encoding, "mapping": column_mapping, "original_base64": base64.b64encode(content).decode("ascii")})
        repo.put("validation_uploads", upload)
        validation_record = record({"run_id": run_id, "project_id": run["project_id"], "upload_id": upload["id"], **result})
        repo.put("validation_processed", validation_record)
        return {key: value for key, value in validation_record.items() if key != "processed"}

    @app.get("/api/projects/{identifier}/validations")
    def validations(identifier: str, request: Request):
        repo = request.app.state.repo
        find(repo, "projects", identifier)
        return [{key: value for key, value in item.items() if key != "processed"}
                for item in repo.list("validation_processed") if item["project_id"] == identifier]

    return app


app = create_app()
