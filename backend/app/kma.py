"""Korea Meteorological Administration (기상청) ASOS records supplied as API exports.

* Daily ground observations (지상관측 일통계): one station per file, including
  pyranometer daily irradiation SI (MJ/m²). Used as ground truth for the
  reanalysis irradiance that drives the physics model.
* Monthly climate normals (평년값 1991–2020): temperature, humidity and
  sunshine duration — the guideline (3.5.1) asks for 30-year climate values.

Station coordinates are KMA station positions where known; otherwise the
containing city centre, labelled as such.
"""

import json
import os
import re
from functools import lru_cache
from pathlib import Path

import pandas as pd

DATA_DIR = Path(os.getenv("KMA_DATA_DIR", Path(__file__).resolve().parents[1] / "data" / "kma"))
DAILY_FILE = "asos_daily.csv"
NORMALS_FILE = "normals_monthly.csv"
META_FILE = "meta.json"
MJ_TO_KWH = 1 / 3.6

STATIONS = {
    108: {"name": "서울", "latitude": 37.5714, "longitude": 126.9658,
          "coordinate_basis": "기상청 서울 관측소(종로구 송월동)"},
    232: {"name": "천안", "latitude": 36.8151, "longitude": 127.1139,
          "coordinate_basis": "천안시 중심 근사(관측소 정확 좌표 아님)"},
}
DAILY_COLUMNS = ["date", "stn", "ta_avg", "ta_max", "ta_max_tm", "ta_min", "ta_min_tm", "hm_avg", "hm_min",
                 "hm_min_tm", "ca_tot", "ss_day", "ss_dur", "si_day", "si_60m_max"]


def _value(text):
    text = text.strip()
    if text in ("", "-9", "-9.0", "-99.9", "-999"):
        return None
    value = float(text)
    return None if value <= -9 else value


def parse_daily(path):
    """API ``kma_sfcdd`` text export: '#'-commented header, comma rows."""
    rows = []
    for line in Path(path).read_text(encoding="cp949", errors="replace").splitlines():
        if not line or line.startswith("#"):
            continue
        cells = line.rstrip(",").split(",")
        if len(cells) < len(DAILY_COLUMNS) or not re.fullmatch(r"\d{8}", cells[0].strip()):
            continue
        row = {"date": pd.Timestamp(cells[0].strip()).date().isoformat(), "stn": int(cells[1])}
        for key, cell in zip(DAILY_COLUMNS[2:], cells[2:len(DAILY_COLUMNS)]):
            row[key] = _value(cell)
        rows.append(row)
    if not rows:
        raise ValueError(f"{os.path.basename(path)}: 기상청 일통계 행을 찾지 못했습니다.")
    return pd.DataFrame(rows)


def parse_normals(path):
    """API ``sun_sfc_norm`` monthly normals: ST, STN, MM, TA, TA_MAX, TA_MIN, HM, SS, CA_TOT."""
    rows = []
    for line in Path(path).read_text(encoding="cp949", errors="replace").splitlines():
        if not line or line.startswith("#"):
            continue
        cells = [cell.strip() for cell in line.rstrip("=").rstrip(",").split(",")]
        if len(cells) < 9 or not cells[0].isdigit():
            continue
        period = {"1991": "1961~1990", "2001": "1971~2000", "2011": "1981~2010", "2021": "1991~2020"}.get(cells[0], cells[0])
        rows.append({"period": period, "stn": int(cells[1]), "month": int(cells[2]), "ta": _value(cells[3]),
                     "ta_max": _value(cells[4]), "ta_min": _value(cells[5]), "hm": _value(cells[6]),
                     "ss_hours": _value(cells[7]), "ca_tot": _value(cells[8])})
    if len(rows) < 12:
        raise ValueError(f"{os.path.basename(path)}: 월별 평년값 12개월이 필요합니다.")
    return pd.DataFrame(rows)


def write(daily, normals, sources, folder=DATA_DIR):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    daily.to_csv(folder / DAILY_FILE, index=False)
    normals.to_csv(folder / NORMALS_FILE, index=False)
    (folder / META_FILE).write_text(json.dumps({"sources": sources}, ensure_ascii=False, indent=1), encoding="utf-8")
    load_daily.cache_clear()
    load_normals.cache_clear()


@lru_cache(maxsize=1)
def load_daily():
    path = DATA_DIR / DAILY_FILE
    return pd.read_csv(path) if path.exists() else None


@lru_cache(maxsize=1)
def load_normals():
    path = DATA_DIR / NORMALS_FILE
    return pd.read_csv(path) if path.exists() else None


def irradiance_check():
    """Compare reanalysis daily GHI with the station pyranometer (SI) day by day.

    Returns calendar-month correction factors (observed ÷ reanalysis) and
    agreement metrics, or None when no daily station file is imported.
    """
    import numpy as np

    from . import weather

    daily = load_daily()
    if daily is None:
        return None
    daily = daily.dropna(subset=["si_day"])
    stn = int(daily.stn.mode().iloc[0])
    site = station(stn)
    if site["latitude"] is None:
        return None
    years = sorted({int(day[:4]) for day in daily.date})
    frame = weather.hourly(site["latitude"], site["longitude"], years)
    by_day = frame.groupby(frame.index.tz_localize(None).normalize()).agg(
        ghi=("ghi", "sum"), temp=("temp_air", "mean"), hours=("ghi", "size"))
    by_day = by_day[by_day.hours == 24]
    by_day.index = by_day.index.strftime("%Y-%m-%d")
    joined = daily[daily.stn == stn].set_index("date").join(by_day, how="inner")
    joined["observed"] = joined.si_day * MJ_TO_KWH
    joined["reanalysis"] = joined.ghi / 1000
    joined["month"] = [int(day[5:7]) for day in joined.index]
    monthly = joined.groupby("month")[["observed", "reanalysis"]].sum()
    factors = (monthly.observed / monthly.reanalysis).round(4)
    by_month = joined.groupby([day[:7] for day in joined.index])[["observed", "reanalysis"]].sum()
    return {
        "station": site, "days": int(len(joined)), "period": f"{joined.index.min()} ~ {joined.index.max()}",
        "daily_correlation": float(np.corrcoef(joined.observed, joined.reanalysis)[0, 1]),
        "overall_ratio": float(joined.reanalysis.sum() / joined.observed.sum()),
        "daily_mape_pct": float((abs(joined.reanalysis - joined.observed) / joined.observed.clip(lower=.5)).mean() * 100),
        "temperature_bias_c": float((joined.temp - joined.ta_avg).mean()),
        "factors": {int(month): float(value) for month, value in factors.items()},
        "monthly": [{"month": key, "observed_kwh_m2": float(row.observed), "reanalysis_kwh_m2": float(row.reanalysis)}
                    for key, row in by_month.iterrows()],
        "basis": "기상청 ASOS 일사계 일적산(SI, MJ/m²÷3.6) ÷ 같은 격자 ERA5 일 GHI 합, 달력 월별",
    }


def climate_check(latitude, longitude, monthly, years, max_km=60):
    """Compare the site's reanalysis monthly climate with the nearest KMA normals.

    ``monthly`` rows need month and temp_air. Sunshine normals are shown for
    reference only: hourly-mean DNI cannot reproduce sunshine duration (a
    threshold on hourly means counts partly sunny hours as sunny). Returns None
    when no normals station is within ``max_km``.
    """
    import math

    normals = load_normals()
    if normals is None:
        return None
    best = None
    for stn in normals.stn.unique():
        site = station(stn)
        if site["latitude"] is None:
            continue
        distance = math.hypot(site["latitude"] - latitude,
                              (site["longitude"] - longitude) * math.cos(math.radians(latitude))) * 111.2
        if distance <= max_km and (best is None or distance < best[0]):
            best = (distance, site)
    if best is None:
        return None
    distance, site = best
    rows = normals[normals.stn == site["stn"]].sort_values("month")
    model = {row["month"]: row for row in monthly}
    table = []
    for row in rows.itertuples():
        reanalysis = model.get(int(row.month), {})
        table.append({"month": int(row.month), "normal_ta": row.ta, "normal_ta_min": row.ta_min,
                      "normal_sunshine_hours": row.ss_hours, "reanalysis_ta": reanalysis.get("temp_air")})
    normal_sun = sum(item["normal_sunshine_hours"] or 0 for item in table)
    return {"station": site, "distance_km": distance, "period": str(rows.period.iloc[0]),
            "analysis_years": f"{years[0]}~{years[-1]}", "months": table,
            "annual_sunshine_normal": normal_sun,
            "temperature_bias_c": sum((item["reanalysis_ta"] or 0) - (item["normal_ta"] or 0) for item in table) / 12,
            "coldest_normal_min_c": min(item["normal_ta_min"] for item in table if item["normal_ta_min"] is not None),
            "basis": "기상청 월별 평년값과 같은 위치 ERA5(분석 기간) 월 평균기온 비교. 일조시간 평년값은 참고용"}


def station(stn):
    return {"stn": int(stn), **STATIONS.get(int(stn), {"name": f"지점 {stn}", "latitude": None,
                                                        "longitude": None, "coordinate_basis": "좌표 미상"})}
