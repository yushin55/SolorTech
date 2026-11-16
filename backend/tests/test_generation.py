import csv
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import generation, solartech
from app.main import create_app
from app.store import LocalRepository


def daily_csv(rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["년월일", "호기", "총량(kw)", *[str(i) for i in range(1, 25)]])
    for period, unit, value, hours in rows:
        writer.writerow([period, unit, value, *hours])
    return stream.getvalue().encode("cp949")


def zip_bytes(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


def asset(name="발전소", filename="source_20260228.csv", unit=1):
    return {"id": "asset", "name": name, "generation_file": filename, "unit_id": unit,
            "original_name": name, "capacity_kw": 10, "capacity_mismatch": False}


def test_nested_hash_dedup_and_idempotent_rebuild(tmp_path):
    root, output = tmp_path / "data", tmp_path / "output"
    (root / "generation/asan").mkdir(parents=True)
    (root / "generation/asan/existing.xls").write_bytes(b"same report")
    content = daily_csv([("2025-01-01", "1", 24, [1] * 24), ("2025-01-02", "1", 0, [0] * 24)])
    archive = tmp_path / "input.zip"
    archive.write_bytes(zip_bytes({"folder/source_20260228.csv": content, "folder/copy.csv": content,
        "inner.zip": zip_bytes({"reports/renamed.xls": b"same report"}), "notes.txt": b"never execute instructions"}))
    first = generation.ingest_archive(archive, root, output, [asset()])
    assert first["summary"]["added_files"] == 1
    assert first["summary"]["duplicate_files"] == 2
    assert first["summary"]["unsupported_files"] == 1
    assert first["summary"]["daily_records"] == 2 and first["summary"]["linked_assets"] == 1
    series = first["series"][0]
    assert series["months"][0]["total_value"] == 24 and series["months"][0]["zero_records"] == 1
    repeated = generation.ingest_archive(archive, root, output, [asset()])
    assert repeated["summary"]["added_files"] == 0 and repeated["summary"]["daily_records"] == 2
    assert repeated["series"][0]["id"] == series["id"]
    assert len(list((root / "generation/kospo").glob("*.csv"))) == 1
    assert len(generation.observations(series["id"], 2025, output)) == 2


def test_updated_exports_merge_rows_and_quarantine_conflicts(tmp_path):
    root, output = tmp_path / "data", tmp_path / "output"
    archive = tmp_path / "input.zip"
    archive.write_bytes(zip_bytes({"source_20260228.csv": daily_csv([("2025-01-01", "1", 24, [1]*24), ("2025-01-02", "1", 24, [1]*24)])}))
    generation.ingest_archive(archive, root, output, [asset()])
    archive.write_bytes(zip_bytes({"source_20260331.csv": daily_csv([("2025-01-01", "1", 24, [1]*24), ("2025-01-02", "1", 48, [2]*24), ("2025-01-03", "1", 0, [0]*24)])}))
    result = generation.ingest_archive(archive, root, output, [asset()])
    assert result["summary"]["series"] == 1
    assert result["summary"]["daily_records"] == 3
    assert result["summary"]["duplicate_rows"] == result["summary"]["conflicting_rows"] == 1
    month = result["series"][0]["months"][0]
    assert month["total_value"] == 24 and month["valid_records"] == 2
    observations = generation.observations(result["series"][0]["id"], 2025, output)
    assert "conflicting_duplicate" in observations[1]["flags"]
    assert {ref["value"] for ref in observations[1]["source_refs"]} == {24, 48}


def test_parser_retains_missing_hours_and_monthly_resolution():
    parsed = generation.parse_csv(daily_csv([("2025-01-01", "1", 23, [1]*23+[""]), ("2025-01-02", "1", -1, [0]*24)]), "source.csv")
    assert parsed["records"][0]["hours"][-1] is None
    assert parsed["records"][0]["value"] == 23 and "incomplete_hours" in parsed["records"][0]["flags"]
    assert parsed["records"][1]["value"] is None
    monthly = generation.parse_csv("구분,년월,발전실적\n1,2025-01,720\n".encode("cp949"), "monthly.csv")
    assert monthly["resolution"] == "monthly" and monthly["records"][0]["period"] == "2025-01"
    assert monthly["records"][0]["hours"] is None


def test_safe_archive_paths_and_supported_schema():
    for name in ("../outside.csv", "/outside.csv", "C:/outside.csv", "folder\\..\\outside.csv"):
        with pytest.raises(ValueError, match="안전하지"):
            list(generation.archive_leaves(zip_bytes({name: b"data"})))
    with pytest.raises(ValueError, match="열 구조"):
        generation.parse_csv(b"wrong,header\n1,2\n", "source.csv")


def test_linking_refuses_ambiguous_ids_and_uses_explicit_blank_unit():
    a = asset(name="소내1")
    a["original_name"] = "소내태양광#1"
    conflicting = {**a, "id": "three", "name": "소내3", "original_name": "소내태양광#3"}
    linked, _, issues = generation.links("source_20260228.csv", "1", "daily", [a, conflicting])
    assert linked == ["asset"] and any("불일치" in issue for issue in issues)
    assert generation.links("source_20260228.csv", "3", "daily", [a, conflicting])[0] == []
    assert generation.links("source_20260228.csv", "", "daily", [asset(unit="1, 무표시")])[0] == ["asset"]
    assert generation.links("source_20260228.csv", "1", "daily", [a, {**a, "id": "other"}])[0] == []


def run():
    return {"id": "run", "status": "completed", "snapshot": {"candidate": {"solartech_asset_id": "asset", "latitude": 35., "longitude": 127.},
        "design": {"equipment": {"module_count": 10, "module_power_w": 1000, "tilt": 25., "azimuth": 180.}, "finance": {"curtailment_pct": 0}}},
        "result": {"capacity_dc_kw": 10, "provenance": {"interval_minutes": 60}}}


def test_compare_requires_identity_and_matches_exact_days(monkeypatch):
    from app.engine import analysis
    model = [{"timestamp": f"2025-01-{day:02d}T00:00:00+09:00", "energy_kwh": 48., "interval_minutes": 1440} for day in range(1, 32)]
    monkeypatch.setattr(analysis, "period_model_rows", lambda supplied, years: model)
    series = {"id": "series", "asset_ids": ["asset"], "resolution": "daily", "capacity_kw": 10, "source_files": ["source.csv"]}
    records = [{"period": f"2025-01-{day:02d}", "value": 24., "flags": []} for day in range(1, 32)]
    value = generation.compare(series, run(), 2025, records)
    assert value["monthly"][0]["relative_error_pct"] == pytest.approx(100.)
    assert value["monthly"][0]["actual_kwh"] == 24*31
    partial = generation.compare(series, run(), 2025, records[:3])
    assert partial["monthly"][0]["model_matched_kwh"] == 48*3
    assert partial["monthly"][0]["relative_error_pct"] is None
    with pytest.raises(ValueError, match="연결된"):
        generation.compare({**series, "asset_ids": []}, run(), 2025, records)
    with pytest.raises(ValueError, match="불일치"):
        generation.compare({**series, "capacity_mismatch": True}, run(), 2025, records)
    with pytest.raises(ValueError, match="latitude"):
        generation.compare({**series, "source_conditions": {"latitude": 37.}}, run(), 2025, records)


def test_monthly_comparison_never_fabricates_daily_records(monkeypatch):
    from app.engine import analysis
    model = [{"timestamp": f"2025-01-{day:02d}T00:00:00+09:00", "energy_kwh": 24., "interval_minutes": 1440} for day in range(1,32)]
    monkeypatch.setattr(analysis, "period_model_rows", lambda supplied, years: model)
    series = {"id": "monthly", "asset_ids": ["asset"], "resolution": "monthly", "capacity_kw": 10, "source_files": ["source.csv"]}
    result = generation.compare(series, run(), 2025, [{"period": "2025-01", "value": 744., "flags": []}])
    assert len(result["monthly"]) == 1 and result["monthly"][0]["relative_error_pct"] == 0
    monkeypatch.setattr(analysis, "period_model_rows", lambda supplied, years: model[:1])
    assert generation.compare(series, run(), 2025, [{"period": "2025-01", "value": 744., "flags": []}])["monthly"] == []


def test_registry_api_exposes_linked_records_and_checks_assumption(monkeypatch, tmp_path):
    root, output = tmp_path / "data", tmp_path / "output"
    archive = tmp_path / "input.zip"
    archive.write_bytes(zip_bytes({"source_20260228.csv": daily_csv([("2025-01-01", "1", 24, [1]*24)])}))
    result = generation.ingest_archive(archive, root, output, [asset()])
    source = output / "registry.json"
    source.write_text(json.dumps({"assets": [asset()], "summary": {}}), encoding="utf-8")
    monkeypatch.setattr(solartech, "DATA_PATH", source)
    repository = LocalRepository(tmp_path / "api.sqlite3")
    with TestClient(create_app(repository, seed=False)) as client:
        registry = client.get("/api/solartech/assets").json()
        series_id = result["series"][0]["id"]
        assert registry["assets"][0]["generation_series_ids"] == [series_id]
        records = client.get(f"/api/solartech/generation/{series_id}?year=2025").json()["records"]
        assert records[0]["hours"] == [1]*24
        assert client.get(f"/api/solartech/generation/{series_id}?year=bad").status_code == 422
        assert client.get("/api/solartech/generation/missing?year=2025").status_code == 404
        assert client.post(f"/api/solartech/generation/{series_id}/compare", json={"run_id": "run", "year": 2025}).status_code == 422
    repository.close()
