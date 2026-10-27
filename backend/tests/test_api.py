import copy
import io
import json
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.store import LocalRepository


@pytest.fixture
def repository(tmp_path):
    repo = LocalRepository(tmp_path / "test.sqlite3")
    yield repo
    repo.close()


@pytest.fixture
def client(repository):
    with TestClient(create_app(repository, seed=True)) as app_client:
        yield app_client


def workspace(client):
    project = client.get("/api/projects").json()[0]
    return client.get(f"/api/projects/{project['id']}/workspace").json()


def completed_run(client, monkeypatch, result=None):
    import app.engine

    default_result = {"capacity_dc_kw": 660, "capacity_ac_kw": 550, "annual_kwh": 12,
                      "specific_yield": 12 / 660, "capacity_factor_pct": 1, "energy_basis": "physics",
                      "monthly": [{"month": i, "energy_kwh": 1, "physics_kwh": 1} for i in range(1, 13)],
                      "hourly": [{"timestamp": "2025-01-01T00:00:00+09:00", "energy_kwh": 1}],
                      "steps": {"costs": {"items": [{"label": "태양광 모듈", "amount": 1}]}},
                      "economics": {"capex": 1, "npv": 0, "bc": 1, "cashflows": [{"year": 0, "net_cashflow": -1}]},
                      "layout": {"modules": [], "module_count": 0},
                      "provenance": {"interval_minutes": 60, "weather_source": "test",
                                     "period": {"start": "2025-01-01", "end": "2026-01-01"}}}
    monkeypatch.setattr(app.engine, "run_analysis", lambda snapshot: result or default_result)
    data = workspace(client)
    design = data["designs"][0]
    response = client.post(f"/api/designs/{design['id']}/runs")
    assert response.status_code == 202
    assert response.json()["status"] == "running"
    identifier = response.json()["id"]
    for _ in range(100):
        run = client.get(f"/api/runs/{identifier}").json()
        if run["status"] != "running":
            assert run["status"] == "completed", run
            return run
        time.sleep(.01)
    pytest.fail("background run did not finish")


def test_seed_catalog_and_crud_persistence(client, repository):
    health = client.get("/api/health").json()
    assert health["storage"] == "local" and "ERA5" in health["weather"]
    data = workspace(client)
    names = [candidate["name"] for candidate in data["candidates"]]
    assert any("예당저수지" in name for name in names) and any("아산정수장" in name for name in names)
    assert not any("가상" in name for name in names)
    asan = next(candidate for candidate in data["candidates"] if candidate.get("reference_plant_id"))
    assert asan["geometry"] is None and asan["site_type"] == "plant"
    assert len(data["designs"]) == 5
    assert data["runs"] == []
    catalog = client.get("/api/catalogs").json()
    assert {module["id"] for module in catalog["modules"]} == {"floating_450", "land_480"}
    assert catalog["defaults"]["equipment"]["module_preset"] == "floating_450"
    created = client.post("/api/projects", json={"name": "새 사업", "description": "검토"})
    assert created.status_code == 201
    identifier = created.json()["id"]
    assert client.patch(f"/api/projects/{identifier}", json={"name": "수정 사업"}).status_code == 200
    assert repository.get("projects", identifier)["name"] == "수정 사업"
    candidate = copy.deepcopy(data["candidates"][0])
    for key in ("id", "project_id", "created_at", "updated_at", "demo"):
        candidate.pop(key)
    response = client.post(f"/api/projects/{identifier}/candidates", json=candidate)
    assert response.status_code == 201
    candidate_id = response.json()["id"]
    design_response = client.post(f"/api/projects/{identifier}/designs", json={"name": "대안", "candidate_id": candidate_id})
    assert design_response.status_code == 201
    design_id = design_response.json()["id"]
    assert client.patch(f"/api/designs/{design_id}", json={"equipment": {"module_count": 20}}).json()["equipment"]["module_count"] == 20
    assert client.post(f"/api/designs/{design_id}/duplicate").status_code == 201
    assert client.post(f"/api/projects/{data['project']['id']}/designs", json={"name": "잘못된 참조", "candidate_id": candidate_id}).status_code == 422
    assert client.delete(f"/api/candidates/{candidate_id}").status_code == 204
    assert repository.get("designs", design_id) is None
    assert client.delete(f"/api/projects/{identifier}").status_code == 204
    assert client.get(f"/api/projects/{identifier}/workspace").status_code == 404


def test_run_snapshot_duplicate_export_and_cascade(client, repository, monkeypatch):
    run = completed_run(client, monkeypatch)
    original_snapshot = copy.deepcopy(run["snapshot"])
    assert client.patch(f"/api/designs/{run['design_id']}", json={"equipment": {"module_count": 800}}).status_code == 200
    assert client.get(f"/api/runs/{run['id']}").json()["snapshot"] == original_snapshot
    summary = workspace(client)
    assert "hourly" not in summary["runs"][0]["result"]
    exported = client.get(f"/api/runs/{run['id']}/csv")
    assert exported.status_code == 200
    assert "cashflow" in exported.text and "generation" in exported.text
    clone = client.post(f"/api/projects/{run['project_id']}/duplicate").json()
    clone_workspace = client.get(f"/api/projects/{clone['id']}/workspace").json()
    assert len(clone_workspace["candidates"]) == 3 and len(clone_workspace["designs"]) == 5
    assert len(clone_workspace["runs"]) == 1
    assert clone_workspace["runs"][0]["id"] != run["id"]
    assert set(item["id"] for item in clone_workspace["designs"]).isdisjoint(item["id"] for item in summary["designs"])
    assert client.delete(f"/api/projects/{run['project_id']}").status_code == 204
    assert repository.get("runs", run["id"]) is None
    assert repository.get("projects", clone["id"]) is not None


def test_workspace_lists_boundaryless_run(client, monkeypatch):
    run = completed_run(client, monkeypatch, {"layout": None, "monthly": [], "provenance": {}})
    summary = client.get(f"/api/projects/{run['project_id']}/workspace")
    assert summary.status_code == 200
    assert summary.json()["runs"][0]["result"]["layout"] is None


def test_background_run_nonblocking_and_failure(client, repository, monkeypatch):
    import app.engine

    release = threading.Event()
    def slow_failure(snapshot):
        release.wait(5)
        raise ValueError("잘못된 설계")
    monkeypatch.setattr(app.engine, "run_analysis", slow_failure)
    design = workspace(client)["designs"][0]
    started = time.monotonic()
    response = client.post(f"/api/designs/{design['id']}/runs")
    try:
        assert time.monotonic()-started < 2
        assert response.status_code == 202
        assert client.get("/api/health").status_code == 200
        identifier = response.json()["id"]
    finally:
        release.set()
    for _ in range(100):
        run = client.get(f"/api/runs/{identifier}").json()
        if run["status"] == "failed":
            assert run["error"] == "잘못된 설계"
            assert client.get(f"/api/runs/{identifier}/csv").status_code == 409
            break
        time.sleep(.01)
    else:
        pytest.fail("failed run was not persisted")


def test_restart_recovers_running(repository):
    repository.put("meta", {"id": "schema_v2"})
    repository.put("runs", {"id": "stale", "status": "running"})
    with TestClient(create_app(repository, seed=False)) as client:
        assert client.get("/api/runs/stale").json()["status"] == "failed"


def test_geometry_and_inputs_reject_invalid(client):
    data = workspace(client)
    identifier = data["project"]["id"]
    candidate = data["candidates"][0]
    assert client.patch(f"/api/candidates/{candidate['id']}", json={"latitude": 100}).status_code == 422
    assert client.patch(f"/api/candidates/{candidate['id']}", json={"site_type": "ocean"}).status_code == 422
    assert client.patch(f"/api/candidates/{candidate['id']}", json={"geometry": {"type": "Polygon", "coordinates": [[[0,0],[1,1],[1,0],[0,1],[0,0]]]}}).status_code == 422
    design_id = data["designs"][0]["id"]
    assert client.patch(f"/api/designs/{design_id}", json={"equipment": {"inverter_efficiency": 96}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"equipment": {"module_count": 200001}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"equipment": {"module_preset": "generic"}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"finance": {"stress_pcts": [120]}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"sensitivity": {}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"finance": {"discount_pct": -1}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"finance": {"unknown": 1}}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", content=b'{"equipment":{"tilt":NaN}}', headers={"Content-Type": "application/json"}).status_code == 422
    assert client.patch(f"/api/designs/{design_id}", json={"equipment": {"module_power_w": True}}).status_code == 422
    assert client.post(f"/api/projects/{identifier}/designs", json={"name": "대안", "candidate_id": "missing"}).status_code == 404


def validation_upload(client, run_id, text, **fields):
    return client.post("/api/validation", data={"run_id": run_id, "mapping": json.dumps({"timestamp": "time", "value": "energy"}), **fields},
                       files={"file": ("actual.csv", text.encode("utf-8-sig"), "text/csv")})


def test_upload_preview_errors_and_original_separation(client, repository, monkeypatch):
    run = completed_run(client, monkeypatch)
    preview = client.post("/api/validation/preview", files={"file": ("actual.csv", "시각,전력량\n2025-01-01,1".encode("cp949"), "text/csv")})
    assert preview.status_code == 200
    assert preview.json()["encoding"] == "cp949"
    assert preview.json()["headers"] == ["시각", "전력량"]
    assert client.post("/api/validation/preview", files={"file": ("bad.csv", b"a,a\n1,2", "text/csv")}).status_code == 422
    assert client.post("/api/validation/preview", files={"file": ("bad.csv", b"a,b\n1,2,3", "text/csv")}).status_code == 422
    assert client.post("/api/validation/preview", files={"file": ("huge.csv", b"x"*(5*1024*1024+1), "text/csv")}).status_code == 422
    uploaded = validation_upload(client, run["id"], "time,energy\n2025-01-01T00:00:00+09:00,1\n2025-01-01T00:00:00+09:00,2\ninvalid,nope\n2025-01-01T01:00:00+09:00,999999")
    assert uploaded.status_code == 201, uploaded.text
    quality = uploaded.json()
    assert quality["diagnostics"]["duplicate_timestamp"] == 2
    assert quality["diagnostics"]["invalid_timestamp"] == 1
    assert quality["diagnostics"]["abnormal_energy"] == 1
    assert all(month["relative_error_pct"] is None for month in quality["monthly"])
    original = repository.list("validation_uploads")[0]
    processed = repository.list("validation_processed")[0]
    assert "original_base64" in original and "processed" not in original
    assert "processed" in processed and "original_base64" not in processed
    assert client.get(f"/api/projects/{run['project_id']}/validations").json()[0]["id"] == quality["id"]
    client.delete(f"/api/projects/{run['project_id']}")
    assert repository.list("validation_uploads") == [] and repository.list("validation_processed") == []


def test_validation_full_coverage_and_cumulative_resets(client, monkeypatch):
    start = datetime(2025, 1, 1, tzinfo=ZoneInfo("Asia/Seoul"))
    hourly = [{"timestamp": (start+timedelta(hours=i)).isoformat(), "energy_kwh": 2} for i in range(744)]
    result = {"hourly": hourly, "provenance": {"interval_minutes": 60}}
    run = completed_run(client, monkeypatch, result)
    text = "time,energy\n" + "\n".join(f"{row['timestamp']},1000" for row in hourly)
    uploaded = validation_upload(client, run["id"], text, unit="Wh")
    assert uploaded.status_code == 201, uploaded.text
    january = uploaded.json()["monthly"][0]
    assert january["actual_kwh"] == 744
    assert january["model_matched_kwh"] == 1488
    assert january["relative_error_pct"] == 100
    assert january["valid_ratio"] == 1
    cumulative = validation_upload(client, run["id"], "time,energy\n2025-01-01T00:00:00,100\n2025-01-01T01:00:00,102\n2025-01-01T02:00:00,1\n2025-01-01T03:00:00,3", measurement="cumulative")
    assert cumulative.status_code == 201
    assert cumulative.json()["diagnostics"]["counter_reset"] == 1
    assert cumulative.json()["diagnostics"]["cumulative_baseline"] == 1
    assert cumulative.json()["valid_rows"] == 2


def test_interval_end_timezone_overlap_and_zero_errors(client, monkeypatch):
    start = datetime(2025, 1, 1, tzinfo=ZoneInfo("Asia/Seoul"))
    hourly = [{"timestamp": (start+timedelta(hours=i)).isoformat(), "energy_kwh": 2} for i in range(744)]
    run = completed_run(client, monkeypatch, {"hourly": hourly, "provenance": {"interval_minutes": 60}})
    # 16:00Z is 01:00 Seoul: an end reading belongs to the 00:00 interval.
    end_measurement = validation_upload(client, run["id"], "time,energy\n2024-12-31T16:00:00Z,0.002", unit="MWh", timestamp_semantics="end")
    assert end_measurement.status_code == 201
    january = end_measurement.json()["monthly"][0]
    assert january["actual_kwh"] == 2
    assert january["model_matched_kwh"] == 2
    assert january["relative_error_pct"] is None  # incomplete month
    overlap = validation_upload(client, run["id"], "time,energy\n2025-01-01T00:00:00,1\n2025-01-01T00:30:00,1")
    assert overlap.json()["diagnostics"]["overlapping_interval"] == 2
    assert overlap.json()["valid_rows"] == 0
    zeros = "time,energy\n" + "\n".join(f"{row['timestamp']},0" for row in hourly)
    zero = validation_upload(client, run["id"], zeros)
    assert zero.json()["monthly"][0]["valid_ratio"] == 1
    assert zero.json()["monthly"][0]["relative_error_pct"] is None


def test_kwater_records_calibration_and_guideline_endpoints(client):
    plants = client.get("/api/plants").json()
    if not plants["plants"]:
        pytest.skip("K-water 실적 자료가 가져와지지 않았습니다.")
    assert len(plants["plants"]) == 27
    asan = next(plant for plant in plants["plants"] if plant["id"] == "asan-2")
    assert asan["capacity_kw"] == pytest.approx(2132.1) and asan["data_kind"] == "generation"
    assert sum(plant["type"] == "floating" for plant in plants["plants"]) == 4
    detail = client.get("/api/plants/asan-2").json()
    assert detail["monthly"] and detail["daily"]
    assert any(day["flag"] == "spike" for day in detail["daily"])
    assert client.get("/api/plants/unknown").status_code == 404
    calibration = client.get("/api/calibration").json()
    assert "predictions" not in calibration
    assert calibration["selected_model"] in calibration["models"]
    physics = calibration["models"]["physics"]["floating"]["mape_pct"]
    assert calibration["models"][calibration["selected_model"]]["floating"]["mape_pct"] <= physics
    rows = client.get("/api/calibration/predictions", params={"plant_id": "asan-2"}).json()
    assert rows and all(row["plant_id"] == "asan-2" for row in rows)
    site = client.get("/api/guideline/site", params={"latitude": 36.79, "longitude": 127.0}).json()
    assert site["optimal_tilt"] == 30 and site["province"] == "충청남도"


def test_v1_synthetic_demo_is_migrated(repository):
    repository.put("projects", {"id": "p", "name": "수상태양광 사전검토 · 합성자료 데모", "demo": True,
                                "description": "합성", "created_at": "2026-01-01", "updated_at": "2026-01-01"})
    repository.put("candidates", {"id": "fake", "project_id": "p", "name": "가상 수면 A", "demo": True})
    repository.put("candidates", {"id": "real", "project_id": "p", "name": "간월호", "demo": False,
                                  "latitude": 36.6, "longitude": 126.4, "geometry": None, "exclusions": []})
    repository.put("designs", {"id": "d1", "project_id": "p", "candidate_id": "fake", "name": "x"})
    repository.put("designs", {"id": "d2", "project_id": "p", "candidate_id": "real", "name": "내 대안",
                               "equipment": {"module_count": 900}, "sensitivity": {}})
    repository.put("runs", {"id": "r", "project_id": "p", "design_id": "d2", "status": "completed"})
    with TestClient(create_app(repository, seed=False)) as client:
        data = client.get("/api/projects/p/workspace").json()
    assert [candidate["id"] for candidate in data["candidates"]] == ["real"]
    assert data["candidates"][0]["site_type"] == "floating"
    assert data["runs"] == []
    design = data["designs"][0]
    assert design["name"] == "내 대안" and design["equipment"]["module_count"] == 900
    assert "sensitivity" not in design and design["equipment"]["module_preset"] == "floating_450"
    assert data["project"]["name"] == "수상태양광 사전검토" and not data["project"]["demo"]


def test_weather_check_serialises_missing_normals(client):
    response = client.get("/api/weather-check")
    assert response.status_code == 200
    body = response.json()
    assert len(body["long_term_years"]) == 30
    if body["normals"]:
        assert len(body["normals"]["months"]) == 12
        assert all(month["ca_tot"] is None for month in body["normals"]["months"])
