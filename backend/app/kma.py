"""Korea Meteorological Administration (기상청) ASOS records supplied as API exports.

* Daily ground observations (지상관측 일통계): one station per file, including
  pyranometer daily irradiation SI (MJ/m²). Used as ground truth for the
  reanalysis irradiance that drives the physics model.
* Monthly climate normals (평년값 1991–2020): temperature, humidity and
  sunshine duration — the guideline (3.5.1) asks for 30-year climate values.

Station coordinates come from the bundled official KMA ASOS table. Stations
without verified coordinates are never selected by geographic proximity.
"""

import json
import math
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

STATION_META = json.loads((Path(__file__).parent / "resources" / "kma_stations.json").read_text(encoding="utf-8"))
STATIONS = {item["stn"]: {k: v for k, v in item.items() if k != "stn"} for item in STATION_META["stations"]}
OBSERVATION_DIR = Path(os.getenv("KMA_OBSERVATION_DIR", Path(__file__).resolve().parents[2] / "data" / "weather" / "asos_daily"))
PROFILE_BASIS = ("데모 가정: 연결 관측소 일자료의 월별 일평균 일사량·기온에 맞춰 후보지 ERA5 시간분포를 조정합니다. "
                 "DNI·DHI에도 같은 일사 비율을 적용하며, 실제 시간별 관측·30년 평년값 또는 검증된 보정 모델이 아닙니다.")
DAILY_COLUMNS = ["date", "stn", "ta_avg", "ta_max", "ta_max_tm", "ta_min", "ta_min_tm", "hm_avg", "hm_min",
                 "hm_min_tm", "ca_tot", "ss_day", "ss_dur", "si_day", "si_60m_max"]


def _value(text):
    text = text.strip()
    if text in ("", "-9", "-9.0", "-99.9", "-999"):
        return None
    value = float(text)
    return None if value in (-9, -99, -99.9, -999, -9999) else value


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


@lru_cache(maxsize=1)
def observation_profiles():
    """Read STN from file contents; never infer the station from a city filename."""
    frames = []
    for path in sorted(OBSERVATION_DIR.glob("*.csv")):
        frames.append(parse_daily(path))
    if not frames:
        return {}
    daily = pd.concat(frames).drop_duplicates(["stn", "date"])
    profiles = {}
    for stn, group in daily.groupby("stn"):
        group = group.copy()
        group["month"] = pd.to_datetime(group.date).dt.month
        rows = []
        for month, data in group.groupby("month"):
            solar = data.si_day.dropna()
            solar = solar[solar >= 0]
            temperature = data.ta_avg.dropna()
            if len(solar) < 20 or len(temperature) < 20:
                continue
            rows.append({"month": int(month), "ghi_kwh_m2_day": float(solar.mean() * MJ_TO_KWH),
                         "temp_air": float(temperature.mean()), "days": int(len(solar))})
        if len(rows) == 12 and int(stn) in STATIONS:
            profiles[int(stn)] = {"months": rows, "period": f"{group.date.min()} ~ {group.date.max()}",
                                  "source": "기상청 ASOS 일통계 제공 CSV · 파일 본문 STN 기준"}
    return profiles


def distance_km(latitude, longitude, site):
    lat1, lat2 = math.radians(latitude), math.radians(site["latitude"])
    dlat = lat2 - lat1
    dlon = math.radians(site["longitude"] - longitude)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, a)))


def station_catalog():
    available = observation_profiles()
    return [{**station(stn), "has_observations": stn in available} for stn in STATIONS]


def nearest_weather(latitude, longitude):
    ordered = sorted(({**site, "distance_km": distance_km(latitude, longitude, site)}
                      for site in station_catalog()), key=lambda item: (item["distance_km"], item["stn"]))
    selected = next((site for site in ordered if site["has_observations"]), None)
    profile = observation_profiles().get(selected["stn"]) if selected else None
    return {"nearest": ordered[0], "selected": selected, "profile": profile,
            "basis": PROFILE_BASIS if selected else "사용 가능한 관측소 일자료 없음 · 후보지 좌표의 ERA5 사용",
            "selection_basis": "공식 ASOS 좌표 간 대권거리 최솟값 · 자료 연결은 월별 일사·기온 12개월 확보 관측소 중 최단거리",
            "coordinate_source": STATION_META["source"], "coordinate_date": STATION_META["retrieved_on"]}


def apply_station_profile(frame, selection):
    """Demo monthly observation profile with ERA5's hourly shape; snapshot-reproducible."""
    if not selection.get("profile"):
        return frame, []
    adjusted = frame.copy()
    factors = []
    for row in selection["profile"]["months"]:
        mask = frame.index.month == row["month"]
        subset = frame.loc[mask]
        if subset.empty:
            continue
        # Hourly mean W/m² -> kWh/m²/day, using the actual hours present.
        mean_daily = float(subset.ghi.mean()) * 24 / 1000
        if mean_daily <= 0:
            continue
        factor = row["ghi_kwh_m2_day"] / mean_daily
        for column in ("ghi", "dni", "dhi"):
            adjusted.loc[mask, column] = subset[column] * factor
        delta = row["temp_air"] - float(subset.temp_air.mean())
        adjusted.loc[mask, "temp_air"] = subset.temp_air + delta
        factors.append({"month": row["month"], "irradiance_factor": factor, "temperature_delta_c": delta})
    adjusted.attrs = dict(frame.attrs)
    adjusted.attrs["source"] = f"{frame.attrs.get('source', 'ERA5')} + 기상청 {selection['selected']['name']} 월별 관측 프로파일(데모)"
    return adjusted, factors
