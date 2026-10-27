"""Operating-record calibration of the physics model with leave-one-plant-out checks.

Pipeline (proposal §기술성 2단계, guideline-independent):

1. For every plant, run pvlib on reanalysis weather for the actual operating
   days, at 1 kWp with the plant's assumed orientation and standard losses.
2. Compare with QC-passed daily records on the *same days* and aggregate to
   plant-months (≥80 % valid days). The target is the ratio measured / physics.
3. Leave-one-plant-out: each plant is predicted by models fitted without it.
   Candidates are physics-only, calendar-month median ratio, a gradient-boosted
   ratio model (GBR) and GBR plus a floating-plant residual step (the proposal's
   "common pattern → floating-specific" transfer). Only a model that beats
   physics-only on held-out floating plants is selected; otherwise physics stays.
4. The selected model's held-out ratios (measured / predicted) give the
   empirical P10–P90 band reported with new-site predictions.

Plant-months whose ratio falls below 65 % of that plant's median are flagged as
suspected partial outages and excluded (a curtailed or half-tripped month is a
data-availability problem, not a weather-to-energy relationship). A plant whose
overall ratio is below 75 % of the cross-plant median is listed for spec review
and excluded from training and headline metrics, never silently dropped.
"""

import json
import math
import threading

import numpy as np
import pandas as pd

from . import kwater, weather
from .engine.energy import interval_energy

DATASET_FILE = "calibration_dataset.csv"
DAILY_MODEL_FILE = "daily_model.csv"
RESULT_FILE = "calibration.json"
STANDARD = {"module_power_w": 1000, "module_count": 1, "ac_capacity_kw": 1.0,
            "inverter_efficiency": .96, "gamma_pdc": -.0035, "system_loss_pct": 14}
FEATURES = ["month_sin", "month_cos", "latitude", "longitude", "log_capacity",
            "is_floating", "is_basin", "physics_per_day", "ghi_per_day", "temp_air"]
MODEL_LABELS = {
    "physics": "물리 모델 단독 (pvlib)",
    "monthly_median": "월별 실적비 중앙값 보정",
    "gbr": "GBR 오차 보정 (전체 발전소 공통)",
    "gbr_floating": "GBR + 수상 발전소 잔차 보정 (2단계)",
}
AVAILABILITY_FACTOR = .65
# A whole plant far below its peers (e.g. traded energy net of on-site use,
# shading, or a capacity mismatch) is held back until its specs are confirmed.
PLANT_OUTLIER_FACTOR = .75
_lock = threading.Lock()
_models = {}


def standard_equipment(tilt, azimuth, floating):
    return {**STANDARD, "tilt": tilt, "azimuth": azimuth, "albedo": .06 if floating else .2}


def _features(frame):
    month = frame["month"].astype(float)
    return pd.DataFrame({
        "month_sin": np.sin(2 * np.pi * month / 12), "month_cos": np.cos(2 * np.pi * month / 12),
        "latitude": frame["latitude"], "longitude": frame["longitude"],
        "log_capacity": np.log10(frame["capacity_kw"].clip(lower=1)),
        "is_floating": (frame["type"] == "floating").astype(float),
        "is_basin": (frame["type"] == "basin").astype(float),
        "physics_per_day": frame["physics_per_day"], "ghi_per_day": frame["ghi_per_day"],
        "temp_air": frame["temp_air"],
    })[FEATURES]


# ---------------------------------------------------------------- dataset build

def build_dataset(progress=print, factors=None):
    """Simulate every registered plant on reanalysis weather; return two frames.

    ``factors`` (calendar month → multiplier) rescales reanalysis irradiance to
    the KMA pyranometer before the physics run.
    """
    plants = kwater.load_registry()
    daily = kwater.load_daily()
    if not plants or daily.empty:
        raise ValueError("K-water 실적 자료가 없습니다. scripts/import_data.py를 먼저 실행하세요.")
    month_rows, day_rows = [], []
    for plant in plants:
        records = daily[daily.plant_id == plant["id"]]
        years = sorted(records.date.dt.year.unique())
        frame = weather.scale_irradiance(weather.hourly(plant["latitude"], plant["longitude"], years), factors)
        equipment = standard_equipment(plant["tilt"], plant["azimuth"], plant["type"] == "floating")
        series, *_ = interval_energy(equipment, plant["latitude"], plant["longitude"], frame)
        by_day = series.groupby(series.index.tz_localize(None).normalize()).agg(
            physics=("kwh", "sum"), ghi=("ghi_wh", "sum"), temp_air=("temp_air", "mean"), hours=("hours", "sum"))
        by_day = by_day[by_day.hours >= 23]  # whole weather days only
        joined = records.set_index("date").join(by_day, how="left")
        joined["measured"] = joined.kwh / plant["capacity_kw"]
        joined["weather_ok"] = joined.physics.notna()
        for day, row in joined.iterrows():
            day_rows.append({"plant_id": plant["id"], "date": day.date().isoformat(),
                             "measured_kwh_per_kwp": None if pd.isna(row.measured) else round(float(row.measured), 4),
                             "physics_kwh_per_kwp": None if pd.isna(row.physics) else round(float(row.physics), 4),
                             "ghi_kwh_m2": None if pd.isna(row.ghi) else round(float(row.ghi) / 1000, 3),
                             "flag": row.flag})
        joined["valid"] = (joined.flag == "ok") & joined.weather_ok
        for (year, month), group in joined.groupby([joined.index.year, joined.index.month]):
            valid = group[group.valid]
            days = pd.Timestamp(year=year, month=month, day=1).days_in_month
            month_rows.append({
                "plant_id": plant["id"], "year": int(year), "month": int(month), "days": days,
                "valid_days": len(valid), "coverage": len(valid) / days,
                "measured": float(valid.measured.sum()), "physics": float(valid.physics.sum()),
                "physics_per_day": float(valid.physics.mean()) if len(valid) else math.nan,
                "ghi_per_day": float(valid.ghi.mean() / 1000) if len(valid) else math.nan,
                "temp_air": float(valid.temp_air.mean()) if len(valid) else math.nan,
                "zero_days": int((group.flag == "zero").sum()), "spike_days": int((group.flag == "spike").sum()),
            })
        progress(f"  {plant['name']}: {len(records)}일, 기상 {len(frame):,}시간")
    months = pd.DataFrame(month_rows)
    months["ratio"] = months.measured / months.physics.where(months.physics > 0)
    months["usable"] = months.coverage >= kwater.MIN_MONTH_COVERAGE
    median = months[months.usable].groupby("plant_id").ratio.median()
    months["availability_flag"] = months.usable & (months.ratio < AVAILABILITY_FACTOR * months.plant_id.map(median))
    kept = months[months.usable & ~months.availability_flag].groupby("plant_id")[["measured", "physics"]].sum()
    plant_ratio = kept.measured / kept.physics
    months["plant_ratio"] = months.plant_id.map(plant_ratio)
    months["plant_outlier"] = months.plant_ratio < PLANT_OUTLIER_FACTOR * plant_ratio.median()
    months["train"] = months.usable & ~months.availability_flag & ~months.plant_outlier
    return months, pd.DataFrame(day_rows)


# ------------------------------------------------------------------- models

def _attach(months, plants=None):
    registry = {plant["id"]: plant for plant in (plants or kwater.load_registry())}
    frame = months.copy()
    for key in ("latitude", "longitude", "capacity_kw", "type"):
        frame[key] = frame.plant_id.map(lambda identifier: registry[identifier][key])
    return frame


class RatioModel:
    """Predicts measured/physics ratio for plant-months; ``kind`` picks the method."""

    def __init__(self, kind, train):
        self.kind = kind
        self.floating_factor = 1.
        self.month_median = train.groupby("month").ratio.median()
        self.overall_median = float(train.ratio.median())
        self.gbr = None
        if kind in ("gbr", "gbr_floating"):
            self.gbr = _fit_gbr(train)
        if kind == "gbr_floating":
            residuals = []
            floating = sorted(train[train.type == "floating"].plant_id.unique())
            # Nested leave-one-floating-plant-out keeps the residual step honest.
            for plant_id in floating:
                inner = _fit_gbr(train[train.plant_id != plant_id])
                held = train[train.plant_id == plant_id]
                predicted = inner.predict(_features(held))
                residuals.extend(held.ratio.to_numpy() / predicted)
            self.floating_factor = float(np.median(residuals)) if residuals else 1.

    def predict(self, frame):
        if self.kind == "physics":
            return np.ones(len(frame))
        if self.kind == "monthly_median":
            return frame.month.map(self.month_median).fillna(self.overall_median).to_numpy(dtype=float)
        ratio = self.gbr.predict(_features(frame))
        if self.kind == "gbr_floating":
            ratio = ratio * np.where(frame.type.to_numpy() == "floating", self.floating_factor, 1.)
        return ratio


def _fit_gbr(train):
    from sklearn.ensemble import GradientBoostingRegressor

    model = GradientBoostingRegressor(loss="huber", n_estimators=250, max_depth=2, learning_rate=.04,
                                      subsample=.8, min_samples_leaf=8, random_state=0)
    model.fit(_features(train), train.ratio)
    return model


def _metrics(rows):
    if rows.empty:
        return None
    error = rows.predicted / rows.measured - 1
    plant = rows.groupby("plant_id").agg(measured=("measured", "sum"), predicted=("predicted", "sum"))
    plant_error = plant.predicted / plant.measured - 1
    return {"months": int(len(rows)), "plants": int(rows.plant_id.nunique()),
            "mape_pct": float(error.abs().mean() * 100), "bias_pct": float(error.mean() * 100),
            "rmse_pct": float(np.sqrt((error ** 2).mean()) * 100),
            "plant_total_abs_error_pct": float(plant_error.abs().mean() * 100)}


def leave_one_plant_out(months):
    train_all = _attach(months)
    train_all = train_all[train_all.train]
    results, predictions = {}, []
    for kind in MODEL_LABELS:
        rows = []
        for plant_id in sorted(train_all.plant_id.unique()):
            train = train_all[train_all.plant_id != plant_id]
            held = train_all[train_all.plant_id == plant_id]
            ratio = RatioModel(kind, train).predict(held)
            for (_, row), value in zip(held.iterrows(), ratio):
                rows.append({"model": kind, "plant_id": plant_id, "type": row.type, "year": int(row.year),
                             "month": int(row.month), "measured": row.measured, "physics": row.physics,
                             "predicted": row.physics * value})
        rows = pd.DataFrame(rows)
        predictions.append(rows)
        results[kind] = {"label": MODEL_LABELS[kind], "all": _metrics(rows),
                         "floating": _metrics(rows[rows.type == "floating"]),
                         "non_floating": _metrics(rows[rows.type != "floating"])}
    return results, pd.concat(predictions, ignore_index=True)


def select_model(results):
    """Lowest held-out floating MAPE, but only if it beats physics-only."""
    def score(kind):
        block = results[kind]["floating"] or results[kind]["all"]
        return block["mape_pct"]

    best = min(results, key=score)
    if best != "physics" and score(best) >= score("physics"):
        best = "physics"
    return best


def _band(predictions, selected, plants):
    rows = predictions[predictions.model == selected].copy()
    rows["ratio"] = rows.measured / rows.predicted
    monthly = {}
    for month in range(1, 13):
        values = rows[rows.month == month].ratio
        if len(values) < 20:
            values = rows.ratio
        monthly[month] = {"p10": float(values.quantile(.1)), "p50": float(values.quantile(.5)),
                          "p90": float(values.quantile(.9)), "n": int(len(values))}
    totals = rows.groupby("plant_id").agg(measured=("measured", "sum"), predicted=("predicted", "sum"))
    annual = totals.measured / totals.predicted
    return {"monthly": monthly,
            "annual": {"p10": float(annual.quantile(.1)), "p50": float(annual.quantile(.5)),
                       "p90": float(annual.quantile(.9)), "n_plants": int(len(annual))},
            "basis": "장소 분리(leave-one-plant-out) 검증에서 학습에 쓰지 않은 발전소의 실측/예측 비율 분포"}


def irradiance_factors():
    """Station correction factors when the stored calibration adopted them, else None."""
    result = load_result()
    correction = (result or {}).get("weather_correction") or {}
    return correction.get("factors") if correction.get("applied") else None


def run_calibration(months):
    results, predictions = leave_one_plant_out(months)
    selected = select_model(results)
    plants = kwater.load_registry()
    names = {plant["id"]: plant["name"] for plant in plants}
    per_plant = []
    for (kind, plant_id), rows in predictions.groupby(["model", "plant_id"]):
        metrics = _metrics(rows)
        per_plant.append({"model": kind, "plant_id": plant_id, "name": names[plant_id], **metrics})
    return {
        "selected_model": selected, "selected_label": MODEL_LABELS[selected],
        "selection_rule": "수상 발전소 장소 분리 검증 월 MAPE가 가장 낮고 물리 모델 단독보다 개선된 모델을 선택합니다. 개선이 없으면 물리 모델을 유지합니다.",
        "models": results, "per_plant": per_plant,
        "band": _band(predictions, selected, plants),
        "predictions": predictions.assign(
            measured=predictions.measured.round(4), physics=predictions.physics.round(4),
            predicted=predictions.predicted.round(4)).to_dict("records"),
        "dataset": {
            "plants": int(months.plant_id.nunique()), "plant_months": int(len(months)),
            "train_months": int(months.train.sum()), "low_coverage_months": int((~months.usable).sum()),
            "availability_flagged_months": int(months.availability_flag.sum()),
            "outlier_plants": [{"plant_id": plant_id, "name": names[plant_id], "ratio": float(rows.plant_ratio.iloc[0]),
                                "median_ratio": float(months.drop_duplicates("plant_id").plant_ratio.median())}
                               for plant_id, rows in months[months.plant_outlier].groupby("plant_id")],
            "period": f"{months.year.min()}-{months.month[months.year == months.year.min()].min():02d} ~ "
                      f"{months.year.max()}-{months.month[months.year == months.year.max()].max():02d}",
        },
        "weather_source": weather.SOURCE,
        "physics_reference": "1 kWp · 시스템 손실 14% · 인버터 96% · γ −0.35%/°C · 가이드라인 지역별 최적경사각·정남향 가정",
    }


def write_outputs(months, days, result, folder=None):
    folder = folder or kwater.DATA_DIR
    months.to_csv(folder / DATASET_FILE, index=False, float_format="%.5f")
    days.to_csv(folder / DAILY_MODEL_FILE, index=False)
    (folder / RESULT_FILE).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    with _lock:
        _models.clear()


def load_result():
    path = kwater.DATA_DIR / RESULT_FILE
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def load_months():
    path = kwater.DATA_DIR / DATASET_FILE
    if not path.exists():
        return None
    return pd.read_csv(path)


def load_daily_model():
    path = kwater.DATA_DIR / DAILY_MODEL_FILE
    return pd.read_csv(path) if path.exists() else None


# ------------------------------------------------------------ new-site use

def fitted_model(exclude_plant=None):
    """Selected model fitted on all usable plant-months (optionally minus one plant)."""
    result = load_result()
    months = load_months()
    if result is None or months is None:
        return None, None
    key = exclude_plant or ""
    with _lock:
        if key not in _models:
            train = _attach(months)
            train = train[train.train.astype(bool)]
            if exclude_plant:
                train = train[train.plant_id != exclude_plant]
            _models[key] = RatioModel(result["selected_model"], train)
        return _models[key], result


def apply(reference, site, exclude_plant=None):
    """Calibrate a long-term 1 kWp standard-loss physics run and scale to the site.

    ``reference`` is ``long_term_energy`` output for ``standard_equipment`` at
    the site's orientation; ``site`` needs latitude, longitude, capacity_kw and
    type. Returns monthly calibrated energy with the validation band, or None
    when no calibration has been built.
    """
    model, result = fitted_model(exclude_plant)
    if model is None:
        return None
    capacity = site["capacity_kw"]
    table = pd.DataFrame(reference["by_year_month"])
    days = pd.to_datetime(dict(year=table.year, month=table.month, day=1)).dt.days_in_month
    frame = table.assign(latitude=site["latitude"], longitude=site["longitude"], capacity_kw=capacity,
                         type=site["type"], physics_per_day=table.kwh / days,
                         ghi_per_day=table.ghi_kwh_m2 / days)
    frame["ratio"] = model.predict(frame)
    frame["kwh"] = frame.kwh * capacity
    frame["calibrated"] = frame.kwh * frame.ratio
    monthly = frame.groupby("month").agg(physics=("kwh", "mean"), calibrated=("calibrated", "mean"),
                                         ratio=("ratio", "mean"))
    band = result["band"]
    rows = []
    for month, row in monthly.iterrows():
        quantiles = band["monthly"][str(month)] if str(month) in band["monthly"] else band["monthly"][month]
        rows.append({"month": int(month), "physics_kwh": float(row.physics), "energy_kwh": float(row.calibrated),
                     "ratio": float(row.ratio), "p10_kwh": float(row.calibrated * quantiles["p10"]),
                     "p90_kwh": float(row.calibrated * quantiles["p90"])})
    annual = sum(row["energy_kwh"] for row in rows)
    by_year = frame.groupby("year").calibrated.sum()
    return {
        "model": result["selected_model"], "model_label": result["selected_label"],
        "monthly": rows, "annual_kwh": annual,
        "annual_p10_kwh": annual * band["annual"]["p10"], "annual_p90_kwh": annual * band["annual"]["p90"],
        "annual_by_year": [{"year": int(year), "energy_kwh": float(value)} for year, value in by_year.items()],
        "band_basis": band["basis"], "band_plants": band["annual"]["n_plants"],
        "excluded_plant": exclude_plant,
        "validation": result["models"][result["selected_model"]],
    }
