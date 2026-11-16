"""Download reanalysis weather for each K-water plant and build the calibration.

Usage (from backend/, after import_data.py):
    .venv/Scripts/python.exe scripts/build_calibration.py

Up to three physics inputs are validated leave-one-plant-out: ERA5 as is, ERA5
rescaled by one KMA pyranometer's monthly factors (Seoul), and ERA5 rescaled by
the pyranometer station nearest to each plant (when several KMA daily files with
SI were imported). The variant with the lowest held-out floating-plant MAPE is
kept; ties keep plain ERA5.

Writes calibration_dataset.csv, daily_model.csv and calibration.json into
backend/data/kwater. Weather is cached in backend/data/weather-cache.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import kma  # noqa: E402
from app.calibration import build_dataset, run_calibration, write_outputs  # noqa: E402


def score(result):
    block = result["models"][result["selected_model"]]
    return (block["floating"] or block["all"])["mape_pct"]


def report(label, result):
    print(f"[{label}] 학습 월 {result['dataset']['train_months']} / 전체 {result['dataset']['plant_months']}")
    for block in result["models"].values():
        overall, floating = block["all"], block["floating"]
        print(f"  {block['label']:<28} 전체 MAPE {overall['mape_pct']:5.1f}%  편향 {overall['bias_pct']:+5.1f}%"
              f"  | 수상 MAPE {floating['mape_pct']:5.1f}%  편향 {floating['bias_pct']:+5.1f}%")
    print("  선택:", result["selected_label"])


def main():
    checks = kma.irradiance_checks()
    check = checks.get(108) or (next(iter(checks.values())) if checks else None)
    print(f"일사계 관측소 {len(checks)}곳:", ", ".join(c["station"]["name"] for c in checks.values()) or "없음")
    print("발전소별 기상자료·물리 모델 계산 (ERA5 그대로)")
    months, days = build_dataset()
    result = run_calibration(months)
    report("ERA5", result)
    variants = {"era5": {"score": score(result), "label": "ERA5 그대로"}}
    candidates = {"era5": (months, days, result)}
    if check:
        print(f"기상청 {check['station']['name']} 일사계 보정계수(전 발전소 공통) 적용 후 재계산")
        k_months, k_days = build_dataset(factors=check["factors"])
        k_result = run_calibration(k_months)
        report("ERA5 × 단일 관측소 일사 보정", k_result)
        variants["era5_kma"] = {"score": score(k_result),
                                "label": f"ERA5 × 기상청 {check['station']['name']} 월별 일사 보정(공통)"}
        candidates["era5_kma"] = (k_months, k_days, k_result)
    if len(checks) > 1:
        print("발전소마다 가장 가까운 일사계 관측소 보정계수 적용 후 재계산")

        def nearest(latitude, longitude):
            near = kma.nearest_correction(latitude, longitude, checks)
            return near["factors"] if near else check["factors"]

        n_months, n_days = build_dataset(factors=nearest)
        n_result = run_calibration(n_months)
        report("ERA5 × 최근접 관측소 일사 보정", n_result)
        variants["era5_kma_nearest"] = {"score": score(n_result),
                                        "label": "ERA5 × 가장 가까운 기상청 일사계 월별 보정"}
        candidates["era5_kma_nearest"] = (n_months, n_days, n_result)
    best = min(variants, key=lambda key: (variants[key]["score"], key != "era5"))
    months, days, result = candidates[best]
    result["weather_correction"] = {
        "applied": best != "era5", "mode": {"era5_kma": "global", "era5_kma_nearest": "nearest"}.get(best),
        "selected": best, "factors": check["factors"] if check else None, "check": check,
        "station_factors": {str(stn): {"station": c["station"], "factors": c["factors"], "days": c["days"],
                                       "daily_correlation": c["daily_correlation"], "overall_ratio": c["overall_ratio"]}
                            for stn, c in checks.items()},
        "variants": variants,
        "rule": "물리 입력(ERA5 그대로 / 단일 관측소 일사 보정 / 최근접 관측소 일사 보정)을 장소 분리 검증해 "
                "수상 발전소 월 MAPE가 가장 낮은 쪽을 사용합니다.",
    }
    write_outputs(months, days, result)
    print("기상 입력:", variants[best]["label"])


if __name__ == "__main__":
    main()
