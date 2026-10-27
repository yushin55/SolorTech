"""Verify a running local region-search API through the Vite proxy.

From the repository root, with both servers running:
backend/.venv/Scripts/python.exe backend/scripts/verify_map_search.py
"""
import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def main():
    results = {}
    with httpx.Client(timeout=15) as client:
        for query in ("수원시", "양평군", "충주시", "합천군", "대한민국", "37.2636,127.0286"):
            response = client.get("http://127.0.0.1:5174/api/geocoding/search", params={"q": query})
            response.raise_for_status()
            payload = response.json()
            assert payload["results"], query
            result = payload["results"][0]
            west, south, east, north = result["bbox"]
            assert west < east and south < north
            results[query] = {key: result[key] for key in ("label", "bbox", "source")}
        tile = client.get("https://tile.openstreetmap.org/7/109/50.png")
        tile.raise_for_status()
        assert tile.headers["content-type"].startswith("image/")
        results["basemap_tile"] = {"status": tile.status_code, "content_type": tile.headers["content-type"]}
    (ROOT / "docs/map-search-verification.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
