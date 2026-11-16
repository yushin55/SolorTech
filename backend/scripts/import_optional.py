"""Build the optional SolarTech equipment registry and generation archive during the server build.

Looks only in ``<raw>/solartech/`` of the private data repository:
- ``*.xlsx``  SolarTech 설비정보 엑셀 → data/solartech/registry.json
- ``*.zip``   발전실적 ZIP (DATA_SolarPowerGeneration*.zip 등) → data/solartech/generation.sqlite3
Missing files are skipped with a note; the app then shows the features as empty.

Usage: python scripts/import_optional.py /raw
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import generation, solartech  # noqa: E402


def main(argv):
    folder = Path(argv[1]) / "solartech"
    workbooks = sorted(folder.glob("*.xlsx")) if folder.is_dir() else []
    if not workbooks:
        print("설비정보 엑셀 없음 (raw/solartech/*.xlsx) - 설비정보 화면은 비어 있습니다.")
        return
    registry = solartech.read_workbook(workbooks[0])
    solartech.DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    solartech.DATA_PATH.write_text(json.dumps(registry, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    print(f"설비정보 {workbooks[0].name}: 발전소 {registry['summary']['plants']}곳")
    for archive in sorted(folder.glob("*.zip")):
        result = generation.ingest_archive(archive, folder / "_generation", solartech.DATA_PATH.parent, registry["assets"])
        print(f"발전실적 {archive.name}: {json.dumps(result['summary'], ensure_ascii=False)}")


if __name__ == "__main__":
    main(sys.argv)
