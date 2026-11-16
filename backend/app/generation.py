"""Local generation archive ingestion, provenance, QA and saved-run comparison.

No source program is executed. Monthly data stays monthly. Ambiguous identities
and conflicting records never become training observations or silent sums.
"""
import calendar
import csv
import hashlib
import io
import json
import math
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from zipfile import ZipFile

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "data/solartech"
MANIFEST = "generation-manifest.json"
DATABASE = "generation.sqlite3"
UNIT_BASIS = ("원본 단위는 kW 또는 미표기입니다. 시간별 1시간 평균전력×1h와 일 총량의 관계를 근거로 "
              "kWh로 해석하는 가정입니다. 확정 계량단위가 아니며 모델 대조 시 명시적으로 선택합니다.")
SOURCE_URLS = {"삼척소내": "https://www.data.go.kr/data/15043391/fileData.do",
               "삼척사택": "https://www.data.go.kr/data/15043390/fileData.do"}


def sha(content):
    return hashlib.sha256(content).hexdigest()


def canonical(value):
    return re.sub(r"[\s_]+", "", unicodedata.normalize("NFC", str(value or "")))


def file_key(value):
    return canonical(re.sub(r"_\d{8}\.csv$", ".csv", Path(str(value or "")).name, flags=re.I))


def _safe_name(name):
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or PureWindowsPath(name).drive or any(part in ("..", "") or ":" in part for part in path.parts):
        raise ValueError(f"안전하지 않은 ZIP 경로: {name}")
    return path


def archive_leaves(content, prefix="", depth=0, budget=None):
    budget = budget if budget is not None else {"bytes": 0, "files": 0}
    if depth > 3:
        raise ValueError("중첩 ZIP은 최대 3단계까지 지원합니다.")
    with ZipFile(io.BytesIO(content)) as archive:
        for info in archive.infolist():
            _safe_name(info.filename)
            if info.is_dir():
                continue
            budget["bytes"] += info.file_size
            budget["files"] += 1
            if info.file_size > 100 * 1024 * 1024 or budget["bytes"] > 500 * 1024 * 1024 or budget["files"] > 10000:
                raise ValueError("ZIP 크기 또는 파일 수가 가져오기 한도를 넘습니다.")
            data = archive.read(info)
            member = f"{prefix}{info.filename}"
            if info.filename.lower().endswith(".zip"):
                yield from archive_leaves(data, member + "!", depth + 1, budget)
            else:
                yield member, data


def number(value):
    try:
        result = float(str(value).strip().replace(",", ""))
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


def _source_title(filename):
    title = re.sub(r"_\d{8}\.csv$", "", filename, flags=re.I)
    return re.sub(r"^한국남부발전\(주\)_+", "", title).strip()


def parse_csv(content, filename):
    for encoding in ("utf-8-sig", "cp949"):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError(f"{filename}: UTF-8/CP949 CSV가 아닙니다.")
    table = csv.DictReader(io.StringIO(text), strict=True)
    fields = table.fieldnames or []
    monthly = {"년월", "발전실적"}.issubset(fields)
    total = next((key for key in ("총량(kw)", "총량", "총량(kWh)") if key in fields), None)
    if not monthly and not ({"년월일", "호기"}.issubset(fields) and total and all(str(i) in fields for i in range(1, 25))):
        raise ValueError(f"{filename}: 지원하지 않는 발전실적 열 구조입니다.")
    records, rejected = [], []
    for row_number, row in enumerate(table, 2):
        try:
            if None in row or any(v is None for v in row.values()):
                raise ValueError("열 수 불일치")
            period = row["년월"].strip() if monthly else row["년월일"].strip()
            if monthly:
                if not re.fullmatch(r"\d{4}-\d{2}", period):
                    raise ValueError("년월 형식 오류")
                date.fromisoformat(period + "-01")
            else:
                date.fromisoformat(period)
            unit = row.get("호기", "").strip()
            value = number(row["발전실적"] if monthly else row[total])
            hours = None if monthly else [number(row[str(i)]) for i in range(1, 25)]
            flags = []
            if value is None:
                flags.append("invalid_value")
            if hours is not None:
                if any(h is None for h in hours):
                    flags.append("incomplete_hours")
                elif value is not None and abs(sum(hours) - value) > max(.1, value * .001):
                    flags.append("hour_total_mismatch")
            records.append({"period": period, "unit": unit, "value": value, "hours": hours,
                            "flags": flags, "source_row": row_number, "raw": row})
        except (ValueError, TypeError) as error:
            rejected.append({"source_row": row_number, "reason": str(error)})
    return {"encoding": encoding, "resolution": "monthly" if monthly else "daily", "records": records,
            "rejected": rejected, "value_header": "발전실적" if monthly else total,
            "unit_basis": UNIT_BASIS, "title": _source_title(filename)}


def links(filename, unit, resolution, assets):
    candidates = [a for a in assets if a.get("generation_file") and file_key(a["generation_file"]) == file_key(filename)]
    basis = "엑셀 발전량 파일명 + 호기"
    if not candidates:
        title = canonical(_source_title(filename).replace("태양광발전실적", ""))
        candidates = [a for a in assets if canonical(a["name"]) == title]
        basis = "발전소명 정확 일치 (엑셀 파일명 미입력)"
    if resolution != "monthly":
        matching = []
        for asset in candidates:
            tokens = [t.strip() for t in str(asset.get("unit_id") or "").split(",")]
            if str(asset.get("unit_id", "")).endswith(".0"):
                tokens = [str(int(float(asset["unit_id"])))]
            if unit in tokens or (not unit and "무표시" in tokens) or (not asset.get("unit_id") and len(candidates) == 1 and unit == "1"):
                matching.append(asset)
        candidates = matching
    # Detect contradictions between an explicit #N in the original name and ID.
    clean = []
    issues = []
    for asset in candidates:
        named = re.search(r"#\s*(\d+)", str(asset.get("original_name") or ""))
        if named and resolution != "monthly" and named[1] != unit:
            issues.append(f"엑셀 호기 ID와 원본 발전소명 불일치: {asset['name']}")
        else:
            clean.append(asset)
    if len(clean) == 1:
        return [clean[0]["id"]], basis, issues
    if len(clean) > 1:
        issues.append("여러 발전소가 같은 파일·호기에 대응하여 자동 연결하지 않음")
    else:
        issues.append("엑셀 발전소·호기 연결 확인 필요")
    return [], basis, issues


def ingest_archive(archive_path, data_root, output_dir, assets):
    """Hash-deduplicate raw leaves, merge observations and atomically publish DB.

    Existing source files are never overwritten. Same identity/period/value is
    deduplicated; a different value for the same identity/period is quarantined.
    Re-running scans the canonical raw collection, not just the latest archive.
    """
    archive_path, data_root, output_dir = map(Path, (archive_path, data_root, output_dir))
    raw_dir = data_root / "generation/kospo"
    raw_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    hashes = defaultdict(list)
    for existing in data_root.rglob("*"):
        if existing.is_file() and existing.suffix.lower() != ".zip":
            hashes[sha(existing.read_bytes())].append(str(existing.relative_to(data_root)))
    manifest_files = []
    provenance_path = raw_dir / "sources.json"
    source_history = json.loads(provenance_path.read_text(encoding="utf-8")) if provenance_path.exists() else {}
    archive_hash = sha(archive_path.read_bytes())
    for member, content in archive_leaves(archive_path.read_bytes()):
        digest = sha(content)
        info = {"archive_member": member, "sha256": digest, "bytes": len(content)}
        if digest in hashes:
            info.update(status="duplicate", existing=hashes[digest])
        elif Path(member).suffix.lower() == ".csv":
            filename = _safe_name(member.split("!")[-1]).name
            target = raw_dir / filename
            if target.exists():
                target = raw_dir / f"{target.stem}__{digest[:12]}.csv"
            target.write_bytes(content)
            relative = str(target.relative_to(data_root))
            hashes[digest].append(relative)
            source_history[digest] = {"source_file": filename, "archive_file": archive_path.name,
                                      "archive_sha256": archive_hash, "archive_member": member, "raw_path": relative}
            info.update(status="added", raw_path=relative)
        else:
            info.update(status="unsupported", reason="현재 가져오기 대상은 발전실적 CSV, 기존 중복 파일은 해시로 확인")
        manifest_files.append(info)
    provenance_path.write_text(json.dumps(source_history, ensure_ascii=False, indent=2), encoding="utf-8")

    # Build a disposable next database; the previous queryable version stays in
    # place if parsing or schema validation fails.
    temporary = output_dir / "generation.next.sqlite3"
    with closing(sqlite3.connect(temporary)) as db:
        db.executescript("DROP TABLE IF EXISTS observations; CREATE TABLE observations (series_id TEXT, period TEXT, value REAL, hours TEXT, flags TEXT, source_refs TEXT, PRIMARY KEY(series_id,period));")
        series = {}
        parsed_files = []
        duplicate_rows, conflict_rows = 0, 0
        for raw_path in sorted(raw_dir.glob("*.csv")):
            digest = sha(raw_path.read_bytes())
            source = source_history.get(digest, {"source_file": raw_path.name, "raw_path": str(raw_path.relative_to(data_root))})
            filename = source["source_file"]
            parsed = parse_csv(raw_path.read_bytes(), filename)
            parsed_files.append({**source, "sha256": digest, "encoding": parsed["encoding"],
                                 "input_rows": len(parsed["records"]) + len(parsed["rejected"]), "rejected": parsed["rejected"]})
            # Ignore export date for identity, preserving it in provenance.
            family = canonical(re.sub(r"_\d{8}\.csv$", "", filename, flags=re.I))
            for row in parsed["records"]:
                identity = f"{family}|{row['unit']}|{parsed['resolution']}"
                series_id = "kospo-" + sha(identity.encode())[:20]
                if series_id not in series:
                    asset_ids, basis, issues = links(filename, row["unit"], parsed["resolution"], assets)
                    matched = next((a for a in assets if a["id"] in asset_ids), None)
                    series[series_id] = {"id": series_id, "name": matched["name"] if matched else parsed["title"],
                        "unit_id": row["unit"], "resolution": parsed["resolution"], "asset_ids": asset_ids,
                        "match_basis": basis, "issues": issues, "capacity_kw": matched.get("capacity_kw") if matched else None,
                        "source_conditions": {key: matched.get(key) for key in ("latitude", "longitude", "tilt_deg", "module_power_w")} if matched else {},
                        "capacity_mismatch": bool(matched and matched.get("capacity_mismatch")),
                        "source_files": [], "value_header": parsed["value_header"], "unit_basis": UNIT_BASIS,
                        "source_url": next((url for label, url in SOURCE_URLS.items() if label in filename), None)}
                item = series[series_id]
                if filename not in item["source_files"]:
                    item["source_files"].append(filename)
                flags = list(row["flags"])
                capacity = item["capacity_kw"]
                if capacity and row["value"] is not None and parsed["resolution"] == "daily" and row["value"] / capacity > 7.5:
                    flags.append("capacity_yield_warning")
                ref = {"sha256": digest, "source_file": filename, "row": row["source_row"]}
                values = (row["value"], json.dumps(row["hours"]), json.dumps(flags))
                previous = db.execute("SELECT value,hours,flags,source_refs FROM observations WHERE series_id=? AND period=?", (series_id, row["period"])).fetchone()
                if previous:
                    refs = json.loads(previous[3]) + [ref]
                    if (previous[0], previous[1]) == values[:2]:
                        duplicate_rows += 1
                    else:
                        conflict_rows += 1
                        flags = list(set(json.loads(previous[2]) + flags + ["conflicting_duplicate"]))
                        # Retain both original values in provenance, exclude the
                        # key entirely from usable totals instead of selecting one.
                        refs[-1].update(value=row["value"], hours=row["hours"])
                        refs[0].setdefault("value", previous[0])
                        db.execute("UPDATE observations SET flags=? WHERE series_id=? AND period=?", (json.dumps(flags), series_id, row["period"]))
                    db.execute("UPDATE observations SET source_refs=? WHERE series_id=? AND period=?", (json.dumps(refs, ensure_ascii=False), series_id, row["period"]))
                else:
                    db.execute("INSERT INTO observations VALUES (?,?,?,?,?,?)", (series_id, row["period"], *values, json.dumps([ref], ensure_ascii=False)))
        for item in series.values():
            records = db.execute("SELECT period,value,flags FROM observations WHERE series_id=? ORDER BY period", (item["id"],)).fetchall()
            months = {}
            diagnostics = Counter()
            for period, value, flag_text in records:
                flags = json.loads(flag_text)
                diagnostics.update(flags)
                key = period[:7]
                month = months.setdefault(key, {"period": key, "total_value": 0., "valid_records": 0, "records": 0, "zero_records": 0, "flagged_records": 0})
                month["records"] += 1
                month["flagged_records"] += bool(flags)
                if value is not None and not {"invalid_value", "conflicting_duplicate"}.intersection(flags):
                    month["total_value"] += value
                    month["valid_records"] += 1
                    month["zero_records"] += value == 0
            for month in months.values():
                expected = 1 if item["resolution"] == "monthly" else calendar.monthrange(int(month["period"][:4]), int(month["period"][5:]))[1]
                month["coverage"] = month["valid_records"] / expected
                if not month["valid_records"]:
                    month["total_value"] = None
            item.update(records=len(records), first=records[0][0], last=records[-1][0], months=list(months.values()), diagnostics=dict(diagnostics))
        db.commit()
    temporary.replace(output_dir / DATABASE)
    result = {"archive_file": archive_path.name, "archive_sha256": archive_hash,
              "imported_at": datetime.now(timezone.utc).isoformat(), "files": manifest_files, "parsed_files": parsed_files,
              "series": list(series.values()), "unit_basis": UNIT_BASIS,
              "summary": {"added_files": sum(f["status"] == "added" for f in manifest_files),
                          "duplicate_files": sum(f["status"] == "duplicate" for f in manifest_files),
                          "unsupported_files": sum(f["status"] == "unsupported" for f in manifest_files),
                          "source_csv_files": len(parsed_files), "series": len(series),
                          "linked_assets": len({asset for s in series.values() for asset in s["asset_ids"]}),
                          "daily_records": sum(s["records"] for s in series.values() if s["resolution"] == "daily"),
                          "monthly_records": sum(s["records"] for s in series.values() if s["resolution"] == "monthly"),
                          "duplicate_rows": duplicate_rows, "conflicting_rows": conflict_rows,
                          "rejected_rows": sum(len(f["rejected"]) for f in parsed_files)},
              "training_note": "단위·설치유형·과거 설비변경이 확정되지 않아 보정 학습에는 자동 추가하지 않습니다. 원본 조회·집계와 선택 설계의 동일 기간 실적 대조에 사용합니다."}
    manifest_tmp = output_dir / "generation-manifest.tmp"
    manifest_tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    manifest_tmp.replace(output_dir / MANIFEST)
    return result


def catalog(folder=DEFAULT_DIR):
    path = Path(folder) / MANIFEST
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def observations(series_id, year=None, folder=DEFAULT_DIR):
    path = Path(folder) / DATABASE
    if not path.exists():
        return []
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        sql = "SELECT period,value,hours,flags,source_refs FROM observations WHERE series_id=?"
        args = [series_id]
        if year is not None:
            sql += " AND period LIKE ?"
            args.append(f"{year}-%")
        rows = db.execute(sql + " ORDER BY period", args).fetchall()
    return [{"period": p, "value": v, "hours": json.loads(h), "flags": json.loads(f), "source_refs": json.loads(r)} for p, v, h, f, r in rows]


def compare(series, run, year, records):
    from .engine.analysis import period_model_rows
    from .validation import validate_measurements

    asset_id = run["snapshot"]["candidate"].get("solartech_asset_id")
    if not asset_id or asset_id not in series["asset_ids"]:
        raise ValueError("이 발전소·호기에 연결된 엑셀 후보지의 완료된 분석을 선택하세요.")
    if series.get("capacity_mismatch"):
        raise ValueError("원본 전체 용량과 모듈 용량이 불일치해 오차 대조를 보류합니다. 원본 제원을 확인하세요.")
    candidate = run["snapshot"]["candidate"]
    equipment = run["snapshot"]["design"]["equipment"]
    resolved = run["result"].get("steps", {})
    conditions = series.get("source_conditions", {})
    checks = [("latitude", candidate["latitude"], .02), ("longitude", candidate["longitude"], .02),
              ("tilt_deg", resolved.get("site", {}).get("tilt", equipment.get("tilt")), 1),
              ("module_power_w", resolved.get("equipment", {}).get("module", {}).get("module_power_w", equipment.get("module_power_w")), 1)]
    for key, selected, tolerance in checks:
        if conditions.get(key) is not None and (selected is None or abs(conditions[key] - selected) > tolerance):
            raise ValueError(f"{key} 조건이 원본 제원과 달라 오차 대조를 보류합니다.")
    rows = [r for r in records if r["value"] is not None and not {"invalid_value", "conflicting_duplicate", "capacity_yield_warning", "hour_total_mismatch"}.intersection(r["flags"])]
    if not rows:
        raise ValueError("선택 연도에 비교 가능한 실적이 없습니다.")
    model = period_model_rows(run, [year])
    warnings = [UNIT_BASIS, "과거 설비 변경·정지·음영과 현재 설계 조건 차이를 함께 확인하세요. 보정 모델 학습은 수행하지 않습니다."]
    if series["resolution"] == "daily":
        table = [{"timestamp": r["period"], "value": str(r["value"]), "plant": series["id"], "capacity": str(series["capacity_kw"])} for r in rows]
        result = validate_measurements(table, {"timestamp": "timestamp", "value": "value", "plant_id": "plant", "capacity_kw": "capacity"}, run,
                                       "generation", "interval", "kWh", "start", 1440, model)
        result.pop("processed", None)
        result["warnings"] += warnings
    else:
        capacity = run["result"]["capacity_dc_kw"]
        if not series["capacity_kw"] or abs(capacity - series["capacity_kw"]) > max(1, series["capacity_kw"] * .01):
            raise ValueError("선택 분석과 원본 설비용량이 달라 비교할 수 없습니다.")
        model_months = defaultdict(float)
        model_hours = defaultdict(float)
        seen = set()
        for r in model:
            if r["timestamp"] in seen:
                raise ValueError("모델 시각이 중복되어 월별 대조를 중단합니다.")
            seen.add(r["timestamp"])
            key = r["timestamp"][:7]
            model_months[key] += r["energy_kwh"]
            model_hours[key] += r.get("interval_minutes", 60) / 60
        monthly = []
        for r in rows:
            predicted = model_months.get(r["period"])
            expected_hours = calendar.monthrange(int(r["period"][:4]), int(r["period"][5:]))[1] * 24
            if predicted is None or abs(model_hours[r["period"]] - expected_hours) > .01:
                continue
            difference = predicted - r["value"]
            error = difference / r["value"] * 100 if r["value"] > 0 else None
            monthly.append({"period": r["period"], "month": int(r["period"][5:]), "actual_kwh": r["value"], "model_matched_kwh": predicted,
                            "relative_error_pct": error, "valid_ratio": 1, "difference_kwh": difference})
        result = {"monthly": monthly, "compatible": True, "row_count": len(records), "valid_rows": len(rows), "warnings": warnings}
    result.update(series_id=series["id"], run_id=run["id"], year=year, unit_assumption="kWh", source_files=series["source_files"],
                  excluded_records=len(records) - len(rows), resolution=series["resolution"])
    return result
