"""Import only nonduplicate generation files and rebuild queryable observations."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import generation, solartech  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--data-root", type=Path, default=Path(__file__).resolve().parents[2] / "data")
    parser.add_argument("--output-dir", type=Path, default=generation.DEFAULT_DIR)
    args = parser.parse_args()
    result = generation.ingest_archive(args.archive, args.data_root, args.output_dir, solartech.load_registry()["assets"])
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
