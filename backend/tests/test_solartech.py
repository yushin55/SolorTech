import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import solartech
from app.main import create_app
from app.store import LocalRepository


def workbook_data(monkeypatch, tmp_path, records):
    """Model the read-only sheet interface; never depend on private source data."""
    headers = list(solartech.FIELDS)
    rows = [tuple(row.get(key) for key in headers) for row in records]
    sheet = SimpleNamespace(title="설비", iter_rows=lambda **kwargs: iter([headers, *rows, (None,) * 34]))

    class Workbook(list):
        def close(self):
            self.closed = True

    book = Workbook([sheet])
    def read(path, **kwargs):
        assert kwargs == {"read_only": True, "data_only": True}
        return book
    monkeypatch.setattr(solartech, "load_workbook", read)
    path = tmp_path / "source.xlsx"
    path.write_bytes(b"read-only-fixture")
    result = solartech.read_workbook(path)
    assert book.closed
    return result


def test_import_preserves_mixed_values_and_recomputes_quality(monkeypatch, tmp_path):
    source = {"통합 발전소명": "혼합 설비", "전체 설치 용량 (kW)": 390,
              "모듈 출력용량 (W)": 170, "모듈 수": 1155, "모듈 용량 계산값 (kW)": 999,
              "차이값 (kW)": 0, "설치각 (˚)": "21~45", "발전량 파일명": "  records.csv  ",
              "인버터 용량 (kW)": "100kW x 3EA, 50kW x 2EA"}
    data = workbook_data(monkeypatch, tmp_path, [source, {"통합 발전소명": "빈 설비"}])
    asset, empty = data["assets"]
    assert data["summary"] == {"plants": 2, "with_coordinates": 0, "generation_references": 1, "capacity_mismatches": 1}
    assert asset["calculated_module_capacity_kw"] == 196.35
    assert asset["capacity_difference_kw"] == 193.65
    assert asset["source_module_capacity_kw"] == 999  # Preserve, don't trust it.
    assert asset["tilt_deg"] is None
    assert asset["inverter_capacity_raw"] == source["인버터 용량 (kW)"]
    assert asset["generation_file"] == "records.csv" and asset["source_row"] == 2
    assert empty["capacity_kw"] is None and not empty["capacity_mismatch"]
    assert "발전량 시계열" in data["generation_note"]


def test_coordinates_duplicates_and_stable_identity(monkeypatch, tmp_path):
    source = {"통합 발전소명": "A", "위도": 33.47526, "경도": 126.6829,
              "전체 설치 용량 (kW)": 100, "모듈 출력용량 (W)": 250, "모듈 수": 400,
              "설치각 (˚)": "25˚(지면경사 : 0˚)"}
    data = workbook_data(monkeypatch, tmp_path, [source, {**source, "통합 발전소명": "B"}])
    assert data["summary"]["with_coordinates"] == 2
    assert all(any("좌표 중복" in issue for issue in a["issues"]) for a in data["assets"])
    assert data["assets"][0]["tilt_deg"] == 25
    reversed_data = workbook_data(monkeypatch, tmp_path, [{**source, "통합 발전소명": "B"}, source])
    assert data["assets"][0]["id"] == reversed_data["assets"][1]["id"]
    with pytest.raises(ValueError, match="중복"):
        workbook_data(monkeypatch, tmp_path, [source, source])


def test_missing_file_is_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(solartech, "DATA_PATH", tmp_path / "missing.json")
    assert solartech.load_registry()["assets"] == []


@pytest.fixture
def api(monkeypatch, tmp_path):
    data = workbook_data(monkeypatch, tmp_path, [{"통합 발전소명": "검토 발전소", "전체 설치 용량 (kW)": 100,
                         "모듈 출력용량 (W)": 250, "모듈 수": 400, "위도": 35, "경도": 127, "설치각 (˚)": 25}])
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(solartech, "DATA_PATH", registry)
    repo = LocalRepository(tmp_path / "db.sqlite3")
    with TestClient(create_app(repo, seed=False)) as client:
        project = client.post("/api/projects", json={"name": "제원 검토"}).json()
        yield client, repo, project["id"], data["assets"][0]["id"]
    repo.close()


def inputs(**changes):
    return {"site_type": "land", "latitude": 35, "longitude": 127, "capacity_kw": 100,
            "module_power_w": 250, "tilt": 25, "azimuth": 180, **changes}


def test_api_mapping_persistence_and_repeat_does_not_overwrite(api):
    client, repo, project_id, asset_id = api
    assert len(client.get("/api/solartech/assets").json()["assets"]) == 1
    url = f"/api/projects/{project_id}/solartech-assets/{asset_id}"
    response = client.post(url, json=inputs(site_type="rooftop"))
    assert response.status_code == 201, response.text
    result = response.json()
    candidate, design = result["candidate"], result["design"]
    assert candidate["geometry"] is None and candidate["reference_plant_id"] is None
    assert candidate["site_type"] == "rooftop" and candidate["roof_tilt_deg"] == 25
    assert candidate["solartech_source"]["asset"]["source_row"] == 2
    equipment = design["equipment"]
    assert equipment["energy_basis"] == "physics" and equipment["module_preset"] == "custom"
    assert equipment["module_power_w"] == 250 and equipment["target_capacity_kw"] == 100
    assert "기본 가정" in equipment["module_source"]
    assert equipment["inverter_model"] == "guideline"
    assert design["costs"]["float_per_kw"] == 0
    assert client.patch(f"/api/candidates/{candidate['id']}", json={**candidate, "name": "수정됨"}).status_code == 200
    repeated = client.post(url, json=inputs(capacity_kw=200)).json()
    assert repeated["already_imported"] and repeated["candidate"]["name"] == "수정됨"
    assert repeated["design"]["equipment"]["target_capacity_kw"] == 100
    assert len(repo.list("candidates")) == len(repo.list("designs")) == 1
    assert repo.get("candidates", candidate["id"])["solartech_source"]["sha256"]


def test_api_rejects_missing_ambiguous_invalid_inputs_before_writing(api):
    client, repo, project_id, asset_id = api
    url = f"/api/projects/{project_id}/solartech-assets/{asset_id}"
    missing_type = inputs()
    del missing_type["site_type"]
    for payload in [missing_type, inputs(latitude=100), inputs(module_power_w=0), inputs(capacity_kw=400000, module_power_w=1)]:
        assert client.post(url, json=payload).status_code == 422
    assert client.post(f"/api/projects/{project_id}/solartech-assets/unknown", json=inputs()).status_code == 404
    assert not repo.list("candidates") and not repo.list("designs")


def test_import_rollback_if_design_write_fails(api, monkeypatch):
    client, repo, project_id, asset_id = api
    original = repo.put
    def put(kind, value):
        if kind == "designs":
            raise RuntimeError("write failed")
        return original(kind, value)
    monkeypatch.setattr(repo, "put", put)
    with pytest.raises(RuntimeError, match="write failed"):
        client.post(f"/api/projects/{project_id}/solartech-assets/{asset_id}", json=inputs())
    assert not repo.list("candidates")


def test_imported_design_runs_physics_with_source_warnings(api, monkeypatch):
    import pandas as pd
    from app import calibration, kma, weather
    from app.engine.analysis import run_analysis

    client, _, project_id, asset_id = api
    imported = client.post(f"/api/projects/{project_id}/solartech-assets/{asset_id}", json=inputs()).json()
    index = pd.date_range("2024-01-01", "2025-01-01", inclusive="left", freq="h", tz="Asia/Seoul")
    daylight = (index.hour >= 10) & (index.hour <= 14)
    frame = pd.DataFrame({"ghi": daylight * 700., "dni": daylight * 600., "dhi": daylight * 100.,
                          "temp_air": 20., "wind_speed": 2.}, index=index)
    frame.attrs.update(interval_minutes=60, source="explicit test fixture")
    monkeypatch.setattr(weather, "hourly", lambda *args: frame)
    monkeypatch.setattr(kma, "climate_check", lambda *args: None)
    monkeypatch.setattr(calibration, "apply", lambda *args, **kwargs: pytest.fail("Equipment data must not become calibration observations"))
    result = run_analysis({"candidate": imported["candidate"], "design": imported["design"], "weather": {"years": [2024]}})
    assert result["energy_basis"] == "physics" and result["annual_kwh"] > 0
    assert result["capacity_dc_kw"] >= 100
    assert sum(month["energy_kwh"] for month in result["monthly"]) == pytest.approx(result["annual_kwh"])
    assert any("SolarTech 제원 출처" in warning for warning in result["provenance"]["warnings"])
