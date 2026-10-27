"""Exercise the real local Firestore emulator, including a full pvlib run.

Run from backend after starting the emulator: .venv/Scripts/python scripts/verify_firestore.py
This script refuses non-loopback emulator endpoints and uses a disposable unique prefix.
"""
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
os.environ.setdefault("FIREBASE_PROJECT_ID", "demo-solar-review")
if os.environ["FIRESTORE_EMULATOR_HOST"] not in {"127.0.0.1:8080", "localhost:8080"}:
    raise RuntimeError("Verification is restricted to the local Firestore emulator on port 8080.")
os.environ["FIRESTORE_COLLECTION_PREFIX"] = "solar_verify_" + uuid.uuid4().hex + "_"

from fastapi.testclient import TestClient
from app.main import create_app
from app.store import FirestoreRepository


def verify():
    repo = FirestoreRepository()
    report = {"storage": "firestore-emulator", "host": os.environ["FIRESTORE_EMULATOR_HOST"],
              "project": os.environ["FIREBASE_PROJECT_ID"], "checks": {}}
    collections = ("projects", "candidates", "designs", "runs", "validation_uploads", "validation_processed", "meta")
    try:
        with TestClient(create_app(repo, seed=True)) as client:
            assert client.get("/api/health").json()["storage"] == "firestore"
            project = client.get("/api/projects").json()[0]
            workspace = client.get(f"/api/projects/{project['id']}/workspace").json()
            assert len(workspace["candidates"]) == 2 and len(workspace["designs"]) == 4
            report["checks"]["seed_crud"] = "passed"
            design = workspace["designs"][0]
            response = client.post(f"/api/designs/{design['id']}/runs")
            assert response.status_code == 202, response.text
            run_id = response.json()["id"]
            deadline = time.monotonic()+120
            while time.monotonic() < deadline:
                run = client.get(f"/api/runs/{run_id}").json()
                if run["status"] != "running":
                    break
                time.sleep(.2)
            assert run["status"] == "completed", run.get("error")
            assert len(run["result"]["hourly"]) == 8760
            serialized = json.dumps(run, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            parts = repo._reference("runs", run_id).get().to_dict()["parts"]
            assert len(serialized) > 1024*1024 and parts > 1
            report["checks"]["pvlib_analysis_and_chunk_roundtrip"] = "passed"
            report["full_run_bytes"] = len(serialized)
            report["chunk_count"] = parts
            report["annual_kwh"] = run["result"]["annual_kwh"]
            report["hourly_rows"] = len(run["result"]["hourly"])
            patch = client.patch(f"/api/designs/{design['id']}", json={"equipment": {"module_count": 1300}})
            assert patch.status_code == 200
            assert client.get(f"/api/runs/{run_id}").json()["snapshot"]["design"]["equipment"]["module_count"] == 1200
            clone = client.post(f"/api/projects/{project['id']}/duplicate")
            assert clone.status_code == 201
            clone_id = clone.json()["id"]
            copy_workspace = client.get(f"/api/projects/{clone_id}/workspace").json()
            assert len(copy_workspace["runs"]) == 1 and copy_workspace["runs"][0]["id"] != run_id
            assert client.get(f"/api/runs/{run_id}/csv").status_code == 200
            report["checks"]["immutable_snapshot_duplicate_export"] = "passed"
            reconnected = FirestoreRepository()
            try:
                assert reconnected.get("runs", run_id)["result"]["annual_kwh"] == run["result"]["annual_kwh"]
            finally:
                reconnected.close()
            report["checks"]["persistence_after_reconnect"] = "passed"
            for identifier in (project["id"], clone_id):
                assert client.delete(f"/api/projects/{identifier}").status_code == 204
            assert all(not repo.list(kind) for kind in collections if kind != "meta")
            report["checks"]["cascade_delete"] = "passed"
    finally:
        for kind in collections:
            for item in repo.list(kind):
                repo.delete(kind, item["id"])
        repo.close()
    report["status"] = "passed"
    destination = Path(__file__).resolve().parents[2]/"docs"/"firestore-verification.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    verify()
