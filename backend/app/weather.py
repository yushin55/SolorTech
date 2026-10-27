"""Observed-history weather from the Open-Meteo Historical Weather API (ECMWF ERA5).

Reanalysis is gridded (≈0.1–0.25°), not a point pyranometer: it is the
key-free, nationwide record used here in place of KMA ASOS, whose API needs a
data.go.kr key. Values are cached per grid point and year as CSV so that the
same request never hits the network twice and analyses are reproducible.

Open-Meteo radiation is the mean of the *preceding* hour, so each timestamp is
an interval end; it is shifted back one hour to the engine's interval-start
convention. Wind is requested in m/s at 10 m.
"""

import os
import threading
from datetime import date
from pathlib import Path

import httpx
import pandas as pd

from .engine.common import TIMEZONE

CACHE_DIR = Path(os.getenv("WEATHER_CACHE_DIR", Path(__file__).resolve().parents[1] / "data" / "weather-cache"))
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE = "Open-Meteo Historical Weather API · ECMWF ERA5 재분석 시간자료 (CC BY 4.0)"
VARIABLES = {"shortwave_radiation": "ghi", "direct_normal_irradiance": "dni",
             "diffuse_radiation": "dhi", "temperature_2m": "temp_air", "wind_speed_10m": "wind_speed"}
GRID = .1
_lock = threading.Lock()


def grid_point(latitude, longitude):
    """Snap to a 0.1° cache key; reanalysis cells are at least this coarse."""
    return round(round(latitude / GRID) * GRID, 2), round(round(longitude / GRID) * GRID, 2)


def _path(latitude, longitude, year):
    return CACHE_DIR / f"era5_{latitude:.2f}_{longitude:.2f}_{year}.csv.gz"


def _download(latitude, longitude, start, end):
    params = {"latitude": latitude, "longitude": longitude, "start_date": start.isoformat(),
              "end_date": end.isoformat(), "hourly": ",".join(VARIABLES), "timezone": TIMEZONE,
              "wind_speed_unit": "ms"}
    try:
        response = httpx.get(ARCHIVE_URL, params=params, timeout=120,
                             headers={"User-Agent": "Soomyeon-FPV-Review/2.0"})
    except httpx.HTTPError as error:
        raise ConnectionError("기상자료(Open-Meteo ERA5)를 내려받지 못했습니다. 네트워크를 확인하세요.") from error
    if response.status_code != 200:
        raise ConnectionError(f"기상자료 서버 응답 오류 {response.status_code}: {response.text[:200]}")
    payload = response.json()["hourly"]
    frame = pd.DataFrame({name: payload[key] for key, name in VARIABLES.items()})
    end_stamps = pd.DatetimeIndex(pd.to_datetime(payload["time"])).tz_localize(
        TIMEZONE, ambiguous="raise", nonexistent="raise")
    frame.index = end_stamps - pd.Timedelta(hours=1)
    frame.index.name = "interval_start"
    return frame


def hourly(latitude, longitude, years):
    """Hourly interval-start frame (W/m², °C, m/s) for the given calendar years.

    A year is cached only when complete; the current partial year is fetched
    up to five days ago (ERA5 latency) and cached under a dated name.
    """
    latitude, longitude = grid_point(latitude, longitude)
    frames = []
    today = date.today()
    for year in sorted(set(int(y) for y in years)):
        if year > today.year:
            raise ValueError(f"{year}년 기상자료는 아직 없습니다.")
        path = _path(latitude, longitude, year)
        if year == today.year:
            path = path.with_name(path.name.replace(".csv.gz", f"_to{today.isoformat()}.csv.gz"))
        with _lock:
            if path.exists():
                frame = pd.read_csv(path, index_col=0)
                frame.index = pd.to_datetime(frame.index, utc=True).tz_convert(TIMEZONE)
            else:
                end = date(year, 12, 31) if year < today.year else date.fromordinal(today.toordinal() - 6)
                frame = _download(latitude, longitude, date(year, 1, 1), end)
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                frame.to_csv(path, float_format="%.2f")
        frames.append(frame)
    frame = pd.concat(frames)
    frame = frame[~frame.index.duplicated(keep="first")].sort_index()
    if frame.isna().any().any():
        # Rare upstream gaps: drop rather than invent values (the engine then
        # integrates only the hours that exist and reports reduced coverage).
        frame = frame.dropna()
    frame.attrs.update(source=SOURCE, latitude=latitude, longitude=longitude, interval_minutes=60,
                       time_convention="start")
    return frame


def scale_irradiance(frame, factors):
    """Multiply GHI/DNI/DHI by a calendar-month factor (station-observed correction)."""
    if not factors:
        return frame
    scaled = frame.copy()
    multiplier = scaled.index.month.map(lambda month: factors.get(month, factors.get(str(month), 1.))).to_numpy(float)
    for column in ("ghi", "dni", "dhi"):
        scaled[column] = scaled[column].to_numpy() * multiplier
    scaled.attrs = dict(frame.attrs)
    return scaled


# KMA climate normals period (평년 1991~2020); the guideline asks for 30-year values.
NORMAL_PERIOD = (1991, 2020)


def long_term_years(count=None):
    """Years for the long-term (평년) energy: 1991–2020 unless WEATHER_YEARS sets the
    number of most recent complete years instead."""
    count = count or os.getenv("WEATHER_YEARS")
    if not count:
        return list(range(NORMAL_PERIOD[0], NORMAL_PERIOD[1] + 1))
    last = date.today().year - 1
    return list(range(last - int(count) + 1, last + 1))
