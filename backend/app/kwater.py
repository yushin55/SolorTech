"""K-water operating records: raw-file parsers, plant registry and daily quality control.

Two real sources are supported and kept distinct:

* ``generation`` — 아산정수장 2차발전설비 monitoring monthly reports (daily inverter
  generation, kWh). The files are HTML tables saved with an ``.xls`` extension.
* ``settlement`` — 발전원별 정산내역 workbook (daily 전력거래량, kWh) for 26 plants.
  Traded/settled energy is not the same quantity as metered generation.

Coordinates of the 26 settlement plants are the team's map-verified site addresses
(발전소_기상관측소_매칭, 2026-11); Asan remains a geocoded point (OSM Nominatim),
not surveyed array centroids; they are only used to pick reanalysis weather cells.
Tilt/azimuth are not in the source files, so each plant uses the same guideline
lookup as a new candidate (표 3-19 nearby K-water site, else 표 3-18) facing south,
labelled as an assumption. Plant type comes from the plant name only; unknown types stay unknown.
"""

import csv
import glob
import json
import os
import re
from datetime import date
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(os.getenv("KWATER_DATA_DIR", Path(__file__).resolve().parents[1] / "data" / "kwater"))
REGISTRY_FILE = "registry.json"
DAILY_FILE = "daily.csv"

# Daily specific yield above this is physically implausible for fixed-tilt PV in
# Korea (clear-sky POA ≈ 8 kWh/m²·day at best); such days are meter catch-up spikes.
SPIKE_KWH_PER_KWP = 7.5
MIN_MONTH_COVERAGE = .8

TYPE_LABELS = {
    "floating": "수상(댐·저수지)",
    "plant": "정수장 부지",
    "basin": "침전지 상부",
    "land": "육상(취수장)",
    "unknown": "미분류(명칭으로 확인 불가)",
}

# id, source column name, type, lat, lon, coordinate basis
_SETTLEMENT_PLANTS = [
    ("daebul", "대불태양광", "unknown", 34.908690, 126.505088, "현장 주소 지도 확인(전남 무안 몽탄면 몽탄로 1140)"),
    ("gosan-plant", "고산정수장태양광", "plant", 35.977791, 127.227034, "현장 주소 지도 확인(전북 완주군 고산면 성재리 27(여과지))"),
    ("hapcheon-floating-2", "합천수상태양광#2", "floating", 35.560355, 128.030955, "현장 주소 지도 확인(경남 합천군 용주면 죽죽리 8)"),
    ("hwangji", "황지태양광", "unknown", 37.209902, 128.988122, "현장 주소 지도 확인(강원 태백시 구와우길 66)"),
    ("cheongju-plant", "청주(정)태양광", "plant", 36.605796, 127.454175, "현장 주소 지도 확인(충북 청주시 서원구 성화동 286)"),
    ("boryeong-plant", "보령정수장태양광", "plant", 36.259383, 126.629980, "현장 주소 지도 확인(충남 보령시 웅천읍 평리 수자원공사길 98)"),
    ("cheonan-plant", "천안(정)태양광", "plant", 36.745624, 127.148275, "현장 주소 지도 확인(충남 천안시 동남구 풍세면 미죽리 121-8)"),
    ("gumi-plant", "구미(정)태양광", "plant", 36.170681, 128.376262, "현장 주소 지도 확인(경북 구미시 고아읍 괴평리 34-3)"),
    ("siheung-plant", "시흥(정)태양광", "plant", 37.351791, 126.792585, "현장 주소 지도 확인(경기도 안산시 단원구 선부동 1169)"),
    ("goyang-plant", "고양(정)태양광", "plant", 37.647502, 126.814731, "현장 주소 지도 확인(경기도 고양시 일산동구 산황동 300)"),
    ("deokso-plant", "덕소(정)태양광", "plant", 37.587332, 127.242044, "현장 주소 지도 확인(경기도 남양주시 와부읍 도곡리 100)"),
    ("miryang-plant", "밀양정수장태양광", "plant", 35.509671, 128.808532, "현장 주소 지도 확인(경남 밀양시 산외면 다원길 93)"),
    ("yangsan-plant", "양산정수장태양광", "plant", 35.421209, 129.051431, "현장 주소 지도 확인(경남 양산시 상북면 상삼5길 126)"),
    ("gosan-basin", "고산(침)태양광", "basin", 35.977791, 127.227034, "현장 주소 지도 확인(전북 완주군 고산면 성재리 27(침전지))"),
    ("haepyeong-basin", "해평(침)태양광", "basin", 36.168593, 128.389972, "현장 주소 지도 확인(경북 구미시 해평면 성수문량길 467-69)"),
    ("deokso-plant-2", "덕소(정) 제2태양광", "plant", 37.587332, 127.242044, "현장 주소 지도 확인(경기도 남양주시 와부읍 도곡리 100)"),
    ("gumi-plant-2", "구미(정) 제2태양광", "plant", 36.166949, 128.376807, "현장 주소 지도 확인(경북 구미시 고아읍 괴평리 409-3)"),
    ("goseong", "고성(조) 태양광", "unknown", 34.985972, 128.245686, "현장 주소 지도 확인(경남 고성군 상리면 부포리 100)"),
    ("boryeong-floating", "보령수상태양광", "floating", 36.255720, 126.672220, "현장 주소 지도 확인(충남 보령시 미산면 용수리 2-4)"),
    ("sihwa-bangameori", "시화방아머리태양광", "unknown", 37.291699, 126.579793, "현장 주소 지도 확인(경기도 안산시 대부북동 1982)"),
    ("siheung-plant-2", "시흥(정)태양광#2", "plant", 37.351791, 126.792585, "현장 주소 지도 확인(경기도 안산시 단원구 선부동 1169)"),
    ("chungju-floating", "충주수상태양광", "floating", 36.926249, 128.062698, "현장 주소 지도 확인(충북 제천시 한수면 북노리 64)"),
    ("gumi-plant-3", "구미(정)제3태양광", "plant", 36.166949, 128.376807, "현장 주소 지도 확인(경북 구미시 고아읍 괴평리 409-3)"),
    ("daecheong-intake", "대청취수장 육상 태양광발전소", "land", 36.531785, 127.506797, "현장 주소 지도 확인(충북 청주시 가덕면 국전리 210 (현황 자료에는 위치 없음, 혜민 님이 확인))"),
    ("seokseong-plant", "석성(정)탄소중립태양광", "plant", 36.273088, 126.974690, "현장 주소 지도 확인(충남 부여군 석성면 왕릉로 371)"),
    ("chungjudam-floating-3", "충주댐수상태양광#3", "floating", 36.922062, 128.064841, "현장 주소 지도 확인(충북 제천시 한수면 상노리 188-2)"),
]
ASAN = ("asan-2", "아산정수장 2차발전설비", "plant", 36.7899, 127.0027, "아산시 행정중심")


def _plant(row, capacity_kw, data_kind, source):
    from .engine.guideline import site_factors

    identifier, name, kind, latitude, longitude, basis = row
    factors = site_factors(latitude, longitude)
    tilt, tilt_basis = factors["optimal_tilt"], factors["tilt_basis"]
    return {"id": identifier, "name": name, "type": kind, "type_label": TYPE_LABELS[kind],
            "capacity_kw": float(capacity_kw), "latitude": latitude, "longitude": longitude,
            "coordinate_basis": basis if basis.startswith("현장 주소") else basis + " · OSM Nominatim 지오코딩(±수 km, 배열 위치 아님)",
            "tilt": float(tilt), "azimuth": 180., "orientation_basis": f"설비 제원 미확보 → 가이드라인 {tilt_basis}·정남향 가정",
            "data_kind": data_kind, "source": source}


def _number(text):
    text = str(text).replace(",", "").strip()
    return float(text) if text not in ("", "None", "-") else None


def parse_asan_reports(folder):
    """Return (capacity_kw, rows) from 아산정수장 monthly HTML reports.

    Each report lists one row per calendar day: generation kWh, CO₂ kg, hours.
    Duplicate months (e.g. ``월간보고서_202501 (2).xls``) keep the first file.
    """
    rows, capacity, seen = [], None, set()
    for path in sorted(glob.glob(os.path.join(folder, "**", "월간보고서_*.xls"), recursive=True)):
        text = Path(path).read_bytes().decode("cp949", errors="replace")
        if "발전년월" not in text:
            continue
        month = re.search(r"발전년월 : <b>(\d{4})년(\d{1,2})월</b>", text)
        cap = re.search(r"전체발전용량 : ([\d.,]+)kWp", text)
        if not month or not cap:
            raise ValueError(f"{os.path.basename(path)}: 발전년월·설비용량을 찾을 수 없습니다.")
        year, mon = int(month.group(1)), int(month.group(2))
        if (year, mon) in seen:
            continue
        seen.add((year, mon))
        value = _number(cap.group(1))
        if capacity is not None and abs(value - capacity) > 1e-6:
            raise ValueError("아산 월간보고서의 설비용량이 파일마다 다릅니다.")
        capacity = value
        cells = re.findall(r"<td[^>]*><b>(\d\d)</b></td>\s*<td[^>]*><b>([-\d.,]+)</b></td>"
                           r"\s*<td[^>]*><b>([-\d.,]+)</b></td>\s*<td[^>]*><b>([-\d.,]+)</b></td>", text)
        for day, kwh, _co2, _hours in cells:
            rows.append({"plant_id": ASAN[0], "date": date(year, mon, int(day)).isoformat(),
                         "kwh": _number(kwh), "source_file": os.path.basename(path)})
    if capacity is None:
        raise ValueError("아산 월간보고서(.xls)를 찾지 못했습니다.")
    return capacity, rows


def parse_settlement(path):
    """Return ({name: capacity_kw}, rows) from the 발전원별 정산내역 workbook."""
    from openpyxl import load_workbook

    sheet = load_workbook(path, read_only=True, data_only=True).worksheets[0]
    table = list(sheet.iter_rows(values_only=True))
    header = next(index for index, row in enumerate(table) if row and row[0] == "기간")
    capacities_row = table[header - 1]
    names = [str(value).strip() if value else "" for value in table[header]]
    capacities = {name: float(capacities_row[index]) for index, name in enumerate(names)
                  if index >= 3 and name and name != "합계"}
    rows = []
    for row in table[header + 1:]:
        if not row or not row[0] or not re.match(r"\d{4}-\d{2}$", str(row[0])):
            continue
        day = re.match(r"(\d+)", str(row[1]))
        if not day or row[2] != "전력거래량":
            continue
        year, mon = map(int, str(row[0]).split("-"))
        for index, name in enumerate(names):
            if name in capacities and index < len(row):
                rows.append({"name": name, "date": date(year, mon, int(day.group(1))).isoformat(),
                             "kwh": _number(row[index]) if row[index] is not None else None,
                             "source_file": os.path.basename(path)})
    return capacities, rows


def build_dataset(folder):
    """Parse the raw K-water folder into a registry and a flagged daily table."""
    asan_capacity, asan_rows = parse_asan_reports(folder)
    workbooks = sorted(glob.glob(os.path.join(folder, "**", "*정산내역*.xlsx"), recursive=True))
    if not workbooks:
        raise ValueError("발전원별 정산내역 .xlsx 파일을 찾지 못했습니다.")
    capacities, settlement_rows = parse_settlement(workbooks[0])
    plants = [_plant(ASAN, asan_capacity, "generation", "아산정수장 태양광 모니터링 월간보고서 · 인버터 전체 일 발전량")]
    by_name = {}
    for row in _SETTLEMENT_PLANTS:
        if row[1] not in capacities:
            raise ValueError(f"정산내역에 '{row[1]}' 열이 없습니다.")
        plant = _plant(row, capacities[row[1]], "settlement", "발전원별 정산내역 · 일 전력거래량")
        plants.append(plant)
        by_name[row[1]] = plant["id"]
    unknown = set(capacities) - set(by_name)
    if unknown:
        raise ValueError("등록되지 않은 정산내역 발전소: " + ", ".join(sorted(unknown)))
    capacity = {plant["id"]: plant["capacity_kw"] for plant in plants}
    daily = asan_rows + [{"plant_id": by_name[row["name"]], "date": row["date"], "kwh": row["kwh"],
                          "source_file": row["source_file"]} for row in settlement_rows]
    for row in daily:
        row["flag"] = daily_flag(row["kwh"], capacity[row["plant_id"]])
    daily.sort(key=lambda row: (row["plant_id"], row["date"]))
    return plants, daily


def daily_flag(kwh, capacity_kw):
    """QC flag for one day: ok, missing, zero (stop/comms loss) or spike (catch-up)."""
    if kwh is None:
        return "missing"
    if kwh <= 0:
        return "zero"
    if kwh / capacity_kw > SPIKE_KWH_PER_KWP:
        return "spike"
    return "ok"


def write_dataset(plants, daily, folder=DATA_DIR):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / REGISTRY_FILE).write_text(json.dumps({"plants": plants, "qc": {
        "spike_kwh_per_kwp": SPIKE_KWH_PER_KWP, "min_month_coverage": MIN_MONTH_COVERAGE}},
        ensure_ascii=False, indent=1), encoding="utf-8")
    with open(folder / DAILY_FILE, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["plant_id", "date", "kwh", "flag", "source_file"])
        writer.writeheader()
        writer.writerows(daily)
    load_registry.cache_clear()
    load_daily.cache_clear()


@lru_cache(maxsize=1)
def load_registry():
    path = DATA_DIR / REGISTRY_FILE
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))["plants"]


@lru_cache(maxsize=1)
def load_daily():
    """Daily records as a DataFrame (plant_id, date, kwh, flag)."""
    import pandas as pd

    path = DATA_DIR / DAILY_FILE
    if not path.exists():
        return pd.DataFrame(columns=["plant_id", "date", "kwh", "flag", "source_file"])
    frame = pd.read_csv(path, dtype={"plant_id": str, "flag": str, "source_file": str})
    frame["date"] = pd.to_datetime(frame["date"])
    return frame


def plant(identifier):
    for item in load_registry():
        if item["id"] == identifier:
            return item
    return None
