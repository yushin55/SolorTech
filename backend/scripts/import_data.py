"""Import the raw data folder into backend/data (raw files are only read).

Usage (from backend/):
    .venv/Scripts/python.exe scripts/import_data.py "C:/.../solar model/v1_official_pipeline/data/raw"

Subfolders are searched for:
  * 월간보고서_YYYYMM.xls        아산정수장 일 발전량 (HTML 표)
  * *정산내역*.xlsx               발전원별 일 전력거래량 (26개 발전소)
  * 기상청API_지상관측데이터_일통계_*.csv   기상청 ASOS 일통계 (일사 SI 포함)
  * 기상청API_평년값_*.csv               기상청 월별 평년값 1991~2020
"""

import glob
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import kma, kwater  # noqa: E402


def find(folder, pattern):
    return sorted(glob.glob(os.path.join(folder, "**", pattern), recursive=True))


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    folder = sys.argv[1]
    plants, daily = kwater.build_dataset(folder)
    kwater.write_dataset(plants, daily)
    flags = Counter(row["flag"] for row in daily)
    print(f"K-water: {len(plants)}개 발전소, {len(daily):,}개 일 자료 → {kwater.DATA_DIR}  QC {dict(flags)}")
    daily_files = find(folder, "기상청API_지상관측데이터_일통계_*.csv")
    normal_files = find(folder, "기상청API_평년값_*.csv")
    if daily_files and normal_files:
        import pandas as pd

        observations = pd.concat([kma.parse_daily(path) for path in daily_files]).drop_duplicates(["stn", "date"])
        normals = pd.concat([kma.parse_normals(path) for path in normal_files]).drop_duplicates(["period", "stn", "month"])
        kma.write(observations, normals, [os.path.basename(path) for path in daily_files + normal_files])
        stations = ", ".join(f"{stn} {kma.station(stn)['name']}" for stn in sorted(observations.stn.unique()))
        print(f"기상청: 일통계 {len(observations):,}일 ({stations}), 평년값 {len(normals)}개월 → {kma.DATA_DIR}")
    else:
        print("기상청 파일을 찾지 못해 건너뜁니다.")


if __name__ == "__main__":
    main()
