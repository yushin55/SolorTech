"""JSON repository with durable local SQLite and explicitly selected Firestore adapters."""
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path


class LocalRepository:
    storage = "local"

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("CREATE TABLE IF NOT EXISTS documents (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id))")
        self.connection.commit()
        self.lock = threading.RLock()
        self.deleted = set()

    def put(self, kind, value):
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False)
        with self.lock, self.connection:
            if (kind, value["id"]) in self.deleted:
                return value
            self.connection.execute("INSERT OR REPLACE INTO documents(kind,id,data) VALUES(?,?,?)", (kind, value["id"], payload))
        return value

    def get(self, kind, identifier):
        with self.lock:
            row = self.connection.execute("SELECT data FROM documents WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, kind):
        with self.lock:
            rows = self.connection.execute("SELECT data FROM documents WHERE kind=? ORDER BY rowid", (kind,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def delete(self, kind, identifier):
        with self.lock, self.connection:
            self.deleted.add((kind, identifier))
            self.connection.execute("DELETE FROM documents WHERE kind=? AND id=?", (kind, identifier))

    def close(self):
        self.connection.close()


class FirestoreRepository:
    """Versioned chunks avoid Firestore's 1 MiB document limit for hourly runs and uploads."""
    storage = "firestore"

    def __init__(self):
        import firebase_admin
        from firebase_admin import credentials, firestore

        project = os.getenv("FIREBASE_PROJECT_ID")
        emulator = os.getenv("FIRESTORE_EMULATOR_HOST")
        credential_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if not project or not (emulator or credential_path):
            raise RuntimeError("Firestore requires FIREBASE_PROJECT_ID and emulator or server credential configuration.")
        options = {"projectId": project}
        if emulator:
            # The emulator accepts a non-sensitive placeholder credential and never contacts Google.
            from google.auth.credentials import AnonymousCredentials
            from google.cloud.firestore import Client
            self.client = Client(project=project, credentials=AnonymousCredentials())
        else:
            app_name = f"solar-{project}"
            try:
                app = firebase_admin.get_app(app_name)
            except ValueError:
                app = firebase_admin.initialize_app(credentials.Certificate(credential_path), options, name=app_name)
            self.client = firestore.client(app=app)
        self.prefix = os.getenv("FIRESTORE_COLLECTION_PREFIX", "solar_")
        self.lock = threading.RLock()
        self.deleted = set()

    def _reference(self, kind, identifier):
        return self.client.collection(self.prefix + kind).document(identifier)

    def put(self, kind, value):
        with self.lock:
            if (kind, value["id"]) in self.deleted:
                return value
            return self._put(kind, value)

    def _put(self, kind, value):
        payload = json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        ref = self._reference(kind, value["id"])
        version = uuid.uuid4().hex
        pieces = [payload[i:i + 350000] for i in range(0, len(payload), 350000)]
        for index, piece in enumerate(pieces):
            ref.collection("chunks").document(f"{version}_{index}").set({"data": piece})
        old = ref.get().to_dict() or {}
        ref.set({"version": version, "parts": len(pieces)})
        for index in range(old.get("parts", 0)):
            ref.collection("chunks").document(f"{old['version']}_{index}").delete()
        return value

    def get(self, kind, identifier):
        ref = self._reference(kind, identifier)
        for _ in range(3):
            item = ref.get().to_dict()
            if not item:
                return None
            pieces = [ref.collection("chunks").document(f"{item['version']}_{i}").get().to_dict() for i in range(item["parts"])]
            if all(piece is not None for piece in pieces):
                return json.loads("".join(piece["data"] for piece in pieces))
            # An update may switch the root version and retire old chunks during a read.
        raise RuntimeError("Firestore record changed repeatedly while reading. Retry the request.")

    def list(self, kind):
        return [self.get(kind, record.id) for record in self.client.collection(self.prefix + kind).stream()]

    def delete(self, kind, identifier):
        with self.lock:
            self.deleted.add((kind, identifier))
            ref = self._reference(kind, identifier)
            for part in ref.collection("chunks").stream():
                part.reference.delete()
            ref.delete()

    def close(self):
        self.client.close()


def create_repository():
    mode = os.getenv("STORAGE_BACKEND", "local").lower()
    if mode == "firestore":
        return FirestoreRepository()
    if mode != "local":
        raise RuntimeError("STORAGE_BACKEND must be local or firestore")
    default_path = Path(__file__).resolve().parents[1] / "data" / "solar.sqlite3"
    return LocalRepository(os.getenv("LOCAL_DB_PATH") or str(default_path))
