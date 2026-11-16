"""Import SolarTech equipment metadata without changing generation/calibration.

Usage: python scripts/import_solartech.py path/to/source.xlsx
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import solartech  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, default=solartech.DATA_PATH)
    args = parser.parse_args()
    result = solartech.read_workbook(args.workbook)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps(result["summary"], ensure_ascii=False))
    print(f"Saved: {args.output}")


if __name__ == "__main__":
    main()
