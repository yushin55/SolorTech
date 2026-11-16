"""Refresh the bundled ASOS coordinate snapshot from KMA's public station table."""
import json
from datetime import date
from html import unescape
from pathlib import Path
import re

import httpx

SOURCE = "https://minwon.kma.go.kr/main/obvStn.do"


def main():
    response = httpx.get(SOURCE, timeout=30, follow_redirects=True)
    response.raise_for_status()
    stations = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", response.text, re.S | re.I):
        cells = [unescape(re.sub(r"<[^>]+>", "", cell)).strip()
                 for cell in re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.S | re.I)]
        if len(cells) < 7 or not cells[0].isdigit():
            continue
        try:
            lat, lon = float(cells[5]), float(cells[6])
        except ValueError:
            continue
        if not 30 < lat < 40 or not 120 < lon < 140:
            continue
        stations.append({"stn": int(cells[0]), "name": cells[3], "latitude": lat, "longitude": lon,
                         "coordinate_basis": "기상청 관측 지점 정보 WGS84", "source": SOURCE})
    if len(stations) < 90:
        raise ValueError(f"Station table changed: found only {len(stations)} rows")
    path = Path(__file__).resolve().parents[1] / "app" / "resources" / "kma_stations.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({"source": SOURCE, "retrieved_on": date.today().isoformat(),
                                "stations": stations}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(stations)} official station coordinates")


if __name__ == "__main__":
    main()
