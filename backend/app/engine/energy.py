"""pvlib physics with interval-average weather and interval-start timestamps.

Weather is always supplied by the caller (observed/reanalysis history from
``app.weather``); no synthetic or typical-year generator exists in this engine.
"""

import numpy as np
import pandas as pd
import pvlib

from .common import ENGINE_VERSION, TIMEZONE, capacities, number

REQUIRED = ["ghi", "dni", "dhi", "temp_air", "wind_speed"]
SEASONS = {"spring": (3, 4, 5), "summer": (6, 7, 8), "autumn": (9, 10, 11), "winter": (12, 1, 2)}


def _weather_intervals(weather):
    """Normalise weather to (frame, interval hours, source, assumptions, warnings)."""
    warnings = []
    assumptions = []
    if weather is None:
        raise ValueError("기상자료가 필요합니다. 관측·재분석 기상자료를 지정하세요.")
    if isinstance(weather, pd.DataFrame):
        frame = weather.copy(deep=True)
        config = dict(weather.attrs)
    elif isinstance(weather, dict):
        config = weather
        frame = pd.DataFrame(weather.get("data", weather.get("records")))
    else:
        raise ValueError("weather: DataFrame 또는 data 행이 있는 객체가 필요합니다.")
    if "timestamp" in frame.columns:
        timestamps = pd.to_datetime(frame.pop("timestamp"), errors="raise")
        frame.index = pd.DatetimeIndex(timestamps)
    if not isinstance(frame.index, pd.DatetimeIndex) or len(frame) == 0:
        raise ValueError("기상자료는 비어 있지 않은 DatetimeIndex 또는 timestamp 열이 필요합니다.")
    if frame.index.hasnans:
        raise ValueError("기상자료에 유효하지 않은 시각이 있습니다.")
    if frame.index.tz is None:
        frame.index = frame.index.tz_localize(TIMEZONE)
        assumptions.append("시간대 없는 기상 시각을 Asia/Seoul로 해석했습니다.")
    else:
        frame.index = frame.index.tz_convert(TIMEZONE)
    if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
        raise ValueError("기상 시각은 중복 없이 오름차순이어야 합니다.")
    if "interval_minutes" in frame.columns:
        durations = pd.to_numeric(frame.pop("interval_minutes"), errors="raise").to_numpy() / 60
    elif config.get("interval_minutes") is not None:
        interval = number(config, "interval_minutes", minimum=.001, maximum=1440)
        durations = np.full(len(frame), interval / 60)
    else:
        differences = np.diff(frame.index.asi8) / 3.6e12
        if len(differences) == 0 or not np.allclose(differences, differences[0], atol=1e-9):
            raise ValueError("불규칙 또는 단일 기상자료에는 행별 interval_minutes가 필요합니다.")
        durations = np.full(len(frame), differences[0])
        assumptions.append("규칙적인 시각 간격을 각 행의 구간 길이로 사용했습니다.")
    convention = config.get("time_convention", "start")
    if convention not in ("start", "end", "midpoint"):
        raise ValueError("time_convention은 start, end, midpoint 중 하나여야 합니다.")
    if convention != "start":
        fraction = 1 if convention == "end" else .5
        frame.index = frame.index - pd.to_timedelta(durations * fraction, unit="h")
    source = str(config.get("source", "사용자 제공 기상자료"))
    durations = np.asarray(durations, dtype=float)
    if not np.isfinite(durations).all() or np.any(durations <= 0) or np.any(durations > 24):
        raise ValueError("기상 구간 길이는 0보다 크고 1440분 이하인 유한한 값이어야 합니다.")
    if len(frame) > 1:
        spacing = np.diff(frame.index.asi8) / 3.6e12
        if np.any(durations[:-1] - spacing > 1e-8):
            raise ValueError("기상 관측 구간이 중첩됩니다.")
        if np.any(spacing - durations[:-1] > 1e-8):
            warnings.append("기상자료에 시간 공백이 있습니다. 누락 구간을 임의 보간하지 않았습니다.")
    if any(key not in frame for key in REQUIRED):
        raise ValueError("기상자료 필수 열: ghi, dni, dhi, temp_air, wind_speed")
    try:
        frame[REQUIRED] = frame[REQUIRED].apply(pd.to_numeric, errors="raise")
    except (ValueError, TypeError) as exc:
        raise ValueError("기상자료에 숫자가 아닌 값이 있습니다.") from exc
    if not np.isfinite(frame[REQUIRED].to_numpy(dtype=float)).all():
        raise ValueError("기상자료의 결측·무한대 값을 먼저 확인해 주세요.")
    if (frame[["ghi", "dni", "dhi", "wind_speed"]] < 0).any().any():
        raise ValueError("일사량과 풍속은 음수일 수 없습니다.")
    if ((frame.temp_air < -90) | (frame.temp_air > 70)).any():
        raise ValueError("temp_air: -90~70°C 범위 밖의 값을 확인해 주세요.")
    return frame, durations, source, assumptions, warnings


def simulate(equipment, latitude, longitude, frame, durations):
    """AC power (kW) per interval and warnings; inputs already normalised."""
    dc_kw, ac_kw = capacities(equipment)
    latitude = number({"latitude": latitude}, "latitude", minimum=-89, maximum=89)
    longitude = number({"longitude": longitude}, "longitude", minimum=-180, maximum=180)
    tilt = number(equipment, "tilt", default=15, minimum=0, maximum=90)
    azimuth = number(equipment, "azimuth", default=180, minimum=0, maximum=360)
    gamma = number(equipment, "gamma_pdc", default=-.0035, minimum=-.02, maximum=0)
    efficiency = number(equipment, "inverter_efficiency", default=.975, minimum=.01, maximum=1)
    loss = number(equipment, "system_loss_pct", default=14, minimum=0, maximum=100) / 100
    albedo = number(equipment, "albedo", default=.06, minimum=0, maximum=1)
    warnings = []
    midpoint = frame.index + pd.to_timedelta(durations / 2, unit="h")
    solar = pvlib.solarposition.get_solarposition(midpoint, latitude, longitude, altitude=50)
    # Work as ndarrays to avoid alignment between starts and midpoint timestamps.
    zenith = solar.apparent_zenith.to_numpy()
    sun_azimuth = solar.azimuth.to_numpy()
    irradiance = pvlib.irradiance.get_total_irradiance(
        tilt, azimuth, zenith, sun_azimuth, frame.dni.to_numpy(), frame.ghi.to_numpy(),
        frame.dhi.to_numpy(), albedo=albedo, model="isotropic")
    night = zenith >= 90
    poa = np.maximum(np.asarray(irradiance["poa_global"]), 0)
    poa[night] = 0
    temperature_parameters = pvlib.temperature.TEMPERATURE_MODEL_PARAMETERS["sapm"]["open_rack_glass_glass"]
    cell_temperature = pvlib.temperature.sapm_cell(
        poa, frame.temp_air.to_numpy(), frame.wind_speed.to_numpy(), **temperature_parameters)
    aoi = pvlib.irradiance.aoi(tilt, azimuth, zenith, sun_azimuth)
    # Apply direct-beam incidence losses; isotropic diffuse kept separate.
    direct = np.maximum(np.asarray(irradiance["poa_direct"]), 0)
    diffuse = np.maximum(np.asarray(irradiance["poa_diffuse"]), 0)
    effective = direct * pvlib.iam.physical(aoi) + diffuse
    effective[night] = 0
    pdc_w = pvlib.pvsystem.pvwatts_dc(effective, cell_temperature, dc_kw * 1000, gamma)
    pdc_w = np.maximum(np.asarray(pdc_w), 0) * (1 - loss)
    if ac_kw > 0:
        # PVWatts inverter pdc0 means AC nameplate / nominal efficiency.
        pac_w = pvlib.inverter.pvwatts(pdc_w, ac_kw * 1000 / efficiency, eta_inv_nom=efficiency)
        power_kw = np.clip(np.asarray(pac_w) / 1000, 0, ac_kw)
    else:
        power_kw = np.zeros(len(frame))
    power_kw[night] = 0
    if not np.isfinite(power_kw).all():
        raise ValueError("기상·설비 조건으로 유한한 출력을 계산할 수 없습니다.")
    return power_kw, poa, warnings


def interval_energy(equipment, latitude, longitude, weather):
    """Interval-start kWh series plus POA (Wh/m² per interval) and metadata."""
    frame, durations, source, assumptions, warnings = _weather_intervals(weather)
    seasonal = equipment.get("seasonal_tilts")
    if seasonal:
        # 가변형: each season is simulated at its own tilt (guideline 표 3-21).
        power_kw, poa, more = np.zeros(len(frame)), np.zeros(len(frame)), []
        months = frame.index.month
        for season, season_months in SEASONS.items():
            mask = np.isin(months, season_months)
            if mask.any():
                part = simulate({**equipment, "tilt": seasonal[season]}, latitude, longitude,
                                frame[mask], durations[mask])
                power_kw[mask], poa[mask] = part[0], part[1]
                more += part[2]
        assumptions = assumptions + ["가변형 구조: 봄·여름·가을·겨울 경사각을 계절별로 바꾸어 계산했습니다."]
        more = list(dict.fromkeys(more))
    else:
        power_kw, poa, more = simulate(equipment, latitude, longitude, frame, durations)
    series = pd.DataFrame({"kwh": power_kw * durations, "poa_wh": poa * durations,
                           "ghi_wh": frame.ghi.to_numpy() * durations,
                           "temp_air": frame.temp_air.to_numpy(), "hours": durations}, index=frame.index)
    return series, source, assumptions, warnings + more


def _monthly_integrals(starts, durations, power_kw):
    starts = pd.DatetimeIndex(starts)
    durations = np.asarray(durations, dtype=float)
    powers = np.asarray(power_kw, dtype=float)
    ends = starts + pd.to_timedelta(durations, unit="h")
    # Most intervals lie inside a single month; only split boundary crossings.
    last_instants = ends - pd.Timedelta(nanoseconds=1)
    same_month = (starts.month == last_instants.month) & (starts.year == last_instants.year)
    monthly = np.bincount(starts.month[same_month] - 1,
                          weights=powers[same_month] * durations[same_month], minlength=12)
    for start, end, power in zip(starts[~same_month], ends[~same_month], powers[~same_month]):
        cursor = start
        while cursor < end:
            boundary = (cursor.normalize().replace(day=1) + pd.DateOffset(months=1))
            segment_end = min(boundary, end)
            monthly[cursor.month - 1] += float(power) * (segment_end - cursor).total_seconds() / 3600
            cursor = segment_end
    return [{"month": month + 1, "energy_kwh": float(value)} for month, value in enumerate(monthly)]


MODEL_ASSUMPTIONS = [
    "시간별 구간 평균 기상을 구간 중앙의 태양 위치에 적용하고 AC kW×실제 구간 시간으로 kWh를 적분합니다.",
    "일출·일몰 시간대처럼 구간 중앙의 태양이 지평선 아래인 시간은 발전량 0으로 처리합니다.",
    "등방성 경사면 일사, 입력 알베도(수면 0.06), 물리적 입사각 손실, SAPM open_rack_glass_glass 온도, PVWatts DC/인버터를 사용합니다.",
    "물리 모델에는 수상 설치에 따른 임의 발전량 가산이 없습니다. 수상 효과는 운영실적 보정 단계에서만 반영합니다.",
    "입력 시스템 손실은 DC에 한 번 적용하고 인버터 변환효율·AC 클리핑을 별도로 계산합니다.",
    "행간 그늘·지형·주변 장애물·오염의 세부 물리모델은 별도 검증하지 않았습니다.",
]


def calculate_energy(equipment, latitude, longitude, weather):
    """Compute AC interval energy for one weather period using pvlib.

    User weather uses interval-average W/m² and °C/m/s. Timestamps are interval
    starts unless time_convention explicitly says otherwise. Irregular inputs
    require each row's interval_minutes, so gaps are never silently integrated.
    """
    dc_kw, ac_kw = capacities(equipment)
    frame, durations, source, assumptions, warnings = _weather_intervals(weather)
    power_kw, _, more = simulate(equipment, latitude, longitude, frame, durations)
    warnings += more
    start = frame.index[0]
    end = frame.index[-1] + pd.to_timedelta(durations[-1], unit="h")
    full_year_start = pd.Timestamp(year=start.year, month=1, day=1, tz=TIMEZONE)
    full_year_end = pd.Timestamp(year=start.year + 1, month=1, day=1, tz=TIMEZONE)
    if start != full_year_start or end != full_year_end or abs(durations.sum() - (end - start).total_seconds()/3600) > 1e-6:
        warnings.append("전체 연도를 빠짐없이 포함하지 않는 자료입니다. 합계는 제공 기간의 발전량입니다.")
    interval_kwh = power_kw * durations
    annual = float(interval_kwh.sum())
    monthly = _monthly_integrals(frame.index, durations, power_kw)
    regular = bool(np.allclose(durations, durations[0]))
    return {
        "capacity_dc_kw": dc_kw, "capacity_ac_kw": ac_kw,
        "annual_kwh": annual, "specific_yield": annual / dc_kw if dc_kw else 0,
        "monthly": monthly,
        "hourly": [{"timestamp": timestamp.isoformat(), "energy_kwh": float(energy),
                    "interval_minutes": float(duration * 60)}
                   for timestamp, energy, duration in zip(frame.index, interval_kwh, durations)],
        "provenance": {
            "model": "pvlib PVWatts + SAPM", "version": ENGINE_VERSION,
            "pvlib_version": pvlib.__version__, "weather_source": source,
            "period": {"start": start.isoformat(), "end": end.isoformat()},
            "interval_minutes": float(durations[0] * 60) if regular else None,
            "interval_convention": "start", "timezone": TIMEZONE,
            "record_count": len(frame), "covered_hours": float(durations.sum()),
            "assumptions": assumptions + MODEL_ASSUMPTIONS, "warnings": warnings,
        },
    }


def long_term_energy(equipment, latitude, longitude, weather):
    """Physics energy for a multi-year record, by calendar year and month.

    Returns per-(year, month) kWh with irradiation/temperature features, the
    mean month across years ("typical"), and the min/max annual totals. Only
    complete years count toward annual statistics.
    """
    dc_kw, ac_kw = capacities(equipment)
    series, source, assumptions, warnings = interval_energy(equipment, latitude, longitude, weather)
    grouped = series.groupby([series.index.year, series.index.month])
    table = pd.DataFrame({"kwh": grouped.kwh.sum(), "poa_kwh_m2": grouped.poa_wh.sum() / 1000,
                          "ghi_kwh_m2": grouped.ghi_wh.sum() / 1000, "temp_air": grouped.temp_air.mean(),
                          "hours": grouped.hours.sum()})
    table.index.names = ["year", "month"]
    table = table.reset_index()
    expected = pd.to_datetime(dict(year=table.year, month=table.month, day=1)).dt.days_in_month * 24
    table["complete"] = table.hours >= expected - 1.5  # tolerate the shifted first hour of a record
    complete_years = [year for year, rows in table.groupby("year") if len(rows) == 12 and rows.complete.all()]
    if not complete_years:
        raise ValueError("완전한 1년 이상의 기상자료가 필요합니다.")
    full = table[table.year.isin(complete_years)]
    typical = full.groupby("month").agg(energy_kwh=("kwh", "mean"), poa_kwh_m2=("poa_kwh_m2", "mean"),
                                       ghi_kwh_m2=("ghi_kwh_m2", "mean"), temp_air=("temp_air", "mean"))
    annual_by_year = full.groupby("year").kwh.sum()
    return {
        "capacity_dc_kw": dc_kw, "capacity_ac_kw": ac_kw,
        "years": complete_years,
        "by_year_month": full.drop(columns=["hours", "complete"]).to_dict("records"),
        "monthly": [{"month": int(month), **{key: float(value) for key, value in row.items()}}
                    for month, row in typical.iterrows()],
        "annual_kwh": float(annual_by_year.mean()),
        "annual_by_year": [{"year": int(year), "energy_kwh": float(value)} for year, value in annual_by_year.items()],
        "provenance": {
            "model": "pvlib PVWatts + SAPM", "version": ENGINE_VERSION,
            "pvlib_version": pvlib.__version__, "weather_source": source,
            "period": {"start": series.index[0].isoformat(), "end": series.index[-1].isoformat()},
            "interval_minutes": 60, "interval_convention": "start", "timezone": TIMEZONE,
            "record_count": len(series), "covered_hours": float(series.hours.sum()),
            "assumptions": assumptions + MODEL_ASSUMPTIONS + [
                f"{complete_years[0]}~{complete_years[-1]}년 {len(complete_years)}개 연도의 시간별 기상으로 각각 계산한 뒤 월별 평균을 기준 발전량으로 사용합니다.",
                "가이드라인 3.5.1(30년 평균 일사량)에 따라 기본은 기상청 평년 기간 1991~2020년입니다(WEATHER_YEARS로 최근 N년 지정 가능).",
            ],
            "warnings": warnings,
        },
    }
