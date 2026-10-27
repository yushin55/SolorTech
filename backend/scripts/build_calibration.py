"""Download reanalysis weather for each K-water plant and build the calibration.

Usage (from backend/, after import_data.py):
    .venv/Scripts/python.exe scripts/build_calibration.py

Two physics inputs are validated leave-one-plant-out: ERA5 as is, and ERA5
irradiance rescaled by KMA pyranometer monthly factors (when a KMA daily file
was imported). The variant whose selected model has the lower held-out
floating-plant MAPE is kept; ties keep plain ERA5.

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
    check = kma.irradiance_check()
    print("발전소별 기상자료·물리 모델 계산 (ERA5 그대로)")
    months, days = build_dataset()
    result = run_calibration(months)
    report("ERA5", result)
    variants = {"era5": {"score": score(result), "label": "ERA5 그대로"}}
    chosen = (months, days, result)
    if check:
        print(f"기상청 {check['station']['name']} 일사계 보정계수 적용 후 재계산")
        k_months, k_days = build_dataset(factors=check["factors"])
        k_result = run_calibration(k_months)
        report("ERA5 × 기상청 일사 보정", k_result)
        variants["era5_kma"] = {"score": score(k_result), "label": "ERA5 × 기상청 월별 일사 보정"}
        if score(k_result) < score(result):
            chosen = (k_months, k_days, k_result)
    months, days, result = chosen
    applied = "era5_kma" in variants and variants["era5_kma"]["score"] < variants["era5"]["score"]
    result["weather_correction"] = {
        "applied": applied, "factors": check["factors"] if check else None, "check": check,
        "variants": variants,
        "rule": "두 물리 입력을 장소 분리 검증해 수상 발전소 월 MAPE가 낮은 쪽을 사용합니다.",
    }
    write_outputs(months, days, result)
    print("기상 입력:", variants["era5_kma"]["label"] if applied else variants["era5"]["label"])


if __name__ == "__main__":
    main()
