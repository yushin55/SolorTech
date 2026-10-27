"""CSV measurement QA and timestamp-aligned comparisons with immutable model runs."""
import calendar
import csv
import io
import math
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

MAX_BYTES = 5 * 1024 * 1024
TIMEZONE = ZoneInfo("Asia/Seoul")
MAPPING_FIELDS = {"timestamp", "value", "plant_id", "capacity_kw", "latitude", "longitude", "module_power_w", "tilt", "azimuth"}


def read_csv(content: bytes):
    if not content or len(content) > MAX_BYTES:
        raise ValueError("CSV 파일은 비어 있지 않은 5 MB 이하 파일이어야 합니다.")
    text = None
    encoding = None
    for candidate in ("utf-8-sig", "cp949"):
        try:
            text = content.decode(candidate)
            encoding = candidate
            break
        except UnicodeDecodeError:
            continue
    if text is None or "\x00" in text:
        raise ValueError("UTF-8 또는 CP949 인코딩 CSV만 지원합니다.")
    try:
        records = list(csv.reader(io.StringIO(text), strict=True))
    except csv.Error as error:
        raise ValueError("CSV 구문을 읽을 수 없습니다.") from error
    if len(records) < 2 or not records[0] or len(records[0]) > 100:
        raise ValueError("헤더와 1개 이상의 데이터 행이 필요합니다 (최대 100개 열).")
    headers = [name.strip() for name in records[0]]
    if any(not name for name in headers) or len(set(headers)) != len(headers):
        raise ValueError("헤더는 비어 있거나 중복될 수 없습니다.")
    if len(records) > 100001:
        raise ValueError("한 번에 최대 100,000개 행을 지원합니다.")
    rows = []
    for index, record in enumerate(records[1:], start=2):
        if not record or all(not item.strip() for item in record):
            continue
        if len(record) != len(headers):
            raise ValueError(f"{index}번째 행의 열 수가 헤더와 다릅니다.")
        rows.append(dict(zip(headers, (item.strip() for item in record))))
    if not rows:
        raise ValueError("데이터 행이 없습니다.")
    return headers, rows, encoding


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("유한한 숫자가 필요합니다.")
    return result


def parse_timestamp(value):
    result = pd.Timestamp(value)
    if pd.isna(result):
        raise ValueError("시각 누락")
    if result.tzinfo is None:
        result = result.tz_localize("Asia/Seoul")
    else:
        result = result.tz_convert("Asia/Seoul")
    return result.to_pydatetime()


def validate_measurements(rows, mapping, run, kind, measurement, unit, timestamp_semantics, interval_minutes, model_rows=None):
    if not isinstance(mapping, dict) or set(mapping) - MAPPING_FIELDS:
        raise ValueError("열 매핑 이름을 확인하세요.")
    if not all(mapping.get(key) in rows[0] for key in ("timestamp", "value")):
        raise ValueError("측정 시각과 전력량 열 매핑이 필요합니다.")
    if mapping["timestamp"] == mapping["value"]:
        raise ValueError("측정 시각과 전력량은 서로 다른 열이어야 합니다.")
    if any(column and column not in rows[0] for column in mapping.values()):
        raise ValueError("매핑한 열이 CSV에 존재하지 않습니다.")
    if kind not in {"generation", "sales", "settlement"} or measurement not in {"interval", "cumulative"}:
        raise ValueError("전력량 종류 또는 측정 방식을 확인하세요.")
    if unit not in {"Wh", "kWh", "MWh"} or timestamp_semantics not in {"start", "end"}:
        raise ValueError("단위 또는 시각 의미를 확인하세요.")
    if interval_minutes < 1 or interval_minutes > 1440 or 1440 % interval_minutes:
        raise ValueError("측정 간격은 1일을 나누는 1~1440분이어야 합니다.")
    duration = timedelta(minutes=interval_minutes)
    factor = {"Wh": .001, "kWh": 1, "MWh": 1000}[unit]
    diagnostics = Counter()
    parsed = []
    metadata_values = defaultdict(list)
    for index, row in enumerate(rows, start=2):
        item = {"source_row": index, "plant_id": row.get(mapping.get("plant_id", ""), "단일 발전소"), "valid": True, "reasons": []}
        try:
            item["time"] = parse_timestamp(row[mapping["timestamp"]])
        except (ValueError, TypeError, OverflowError):
            item["valid"] = False
            item["time"] = None
            item["reasons"].append("invalid_timestamp")
            diagnostics["invalid_timestamp"] += 1
        try:
            item["raw_kwh"] = number(row[mapping["value"]]) * factor
            if item["raw_kwh"] < 0:
                raise ValueError("negative")
        except (ValueError, TypeError):
            item["valid"] = False
            item["raw_kwh"] = None
            item["reasons"].append("invalid_value")
            diagnostics["invalid_value"] += 1
        for key in MAPPING_FIELDS - {"timestamp", "value", "plant_id"}:
            column = mapping.get(key)
            if column and row[column]:
                try:
                    metadata_values[key].append(number(row[column]))
                except ValueError:
                    diagnostics["invalid_metadata"] += 1
        parsed.append(item)
    counts = Counter((item["plant_id"], item["time"]) for item in parsed if item["time"])
    previous = {}
    equipment = dict(run["snapshot"]["design"]["equipment"])
    resolved = (run.get("result") or {}).get("steps", {})
    if resolved.get("site"):
        equipment.update(tilt=resolved["site"]["tilt"], module_count=resolved["equipment"]["module_count"])
    model_capacity = equipment["module_count"] * equipment["module_power_w"] / 1000
    capacities = metadata_values.get("capacity_kw", [])
    capacity = capacities[0] if capacities and capacities[0] > 0 else model_capacity
    for item in sorted(parsed, key=lambda record: (record["time"] or datetime.min.replace(tzinfo=TIMEZONE), record["source_row"])):
        time = item["time"]
        raw = item["raw_kwh"]
        key = item["plant_id"]
        energy = raw
        if time and counts[(key, time)] > 1:
            item["valid"] = False
            item["reasons"].append("duplicate_timestamp")
            diagnostics["duplicate_timestamp"] += 1
        if measurement == "cumulative" and time and raw is not None:
            prior = previous.get(key)
            if prior is None:
                item["valid"] = False
                item["reasons"].append("cumulative_baseline")
                diagnostics["cumulative_baseline"] += 1
            elif time - prior[0] != duration:
                item["valid"] = False
                item["reasons"].append("cumulative_gap")
                diagnostics["cumulative_gap"] += 1
            elif raw < prior[1]:
                item["valid"] = False
                item["reasons"].append("counter_reset")
                diagnostics["counter_reset"] += 1
            else:
                energy = raw - prior[1]
            if counts[(key, time)] == 1:
                previous[key] = (time, raw)
        # A cumulative reading is a boundary reading; a delta ends at its timestamp.
        start = time - duration if time and (timestamp_semantics == "end" or measurement == "cumulative") else time
        item["start"] = start
        if item["valid"] and energy is not None and energy > capacity * interval_minutes / 60 * 1.25:
            item["valid"] = False
            item["reasons"].append("abnormal_energy")
            diagnostics["abnormal_energy"] += 1
        item["energy_kwh"] = energy if item["valid"] else None
    previous_interval = {}
    for item in sorted((row for row in parsed if row["valid"]), key=lambda row: row["start"]):
        key = item["plant_id"]
        prior = previous_interval.get(key)
        if prior and item["start"] < prior["start"]+duration:
            for overlap in (prior, item):
                if "overlapping_interval" not in overlap["reasons"]:
                    overlap["reasons"].append("overlapping_interval")
                    overlap["valid"] = False
                    overlap["energy_kwh"] = None
                    diagnostics["overlapping_interval"] += 1
        previous_interval[key] = item
    warnings = []
    compatible = True
    ids = {item["plant_id"] for item in parsed}
    if len(ids) > 1:
        compatible = False
        warnings.append("여러 발전소가 포함되어 단일 설계와의 오차 비교를 중단했습니다.")
    candidate = run["snapshot"]["candidate"]
    expected_metadata = {"capacity_kw": model_capacity, "latitude": candidate["latitude"], "longitude": candidate["longitude"],
                         "module_power_w": equipment["module_power_w"], "tilt": equipment["tilt"], "azimuth": equipment["azimuth"]}
    tolerances = {"capacity_kw": max(1, model_capacity*.01), "latitude": .02, "longitude": .02, "module_power_w": 1, "tilt": 1, "azimuth": 1}
    for key, values in metadata_values.items():
        if values and any(abs(value - expected_metadata[key]) > tolerances[key] for value in values):
            compatible = False
            warnings.append(f"{key} 자료가 분석 스냅샷과 다릅니다. 오차를 계산하지 않습니다.")
    if diagnostics["invalid_metadata"]:
        compatible = False
        warnings.append("숫자로 읽을 수 없는 설비 정보가 있어 비교 적합성을 확인할 수 없습니다.")
    if not capacities:
        warnings.append("설비용량 미제공: 선택한 실행의 DC 용량을 이상치 점검 가정으로 사용했습니다.")
    if len(metadata_values) < 6:
        warnings.append("미제공 위치·설비 정보는 사용자가 선택한 실행과 동일하다고 가정합니다.")
    if kind != "generation":
        warnings.append("판매·정산 전력량 비교이며 실제 발전량 검증과 구분됩니다. 모델 발전량에 선택한 실행의 출력제한 가정만 적용했습니다.")
    if measurement == "cumulative":
        warnings.append("누적 계량값의 차분은 끝 시각 기준입니다. 첫 행·리셋·누락 구간을 제외했습니다.")
    model_rows = model_rows if model_rows is not None else run.get("result", {}).get("hourly", [])
    if not model_rows:
        raise ValueError("선택한 실행에 시간별 모델 출력이 없습니다.")
    model_minutes = run["result"].get("provenance", {}).get("interval_minutes") or 60
    sale_factor = 1 if kind == "generation" else 1-run["snapshot"]["design"]["finance"]["curtailment_pct"]/100
    # Each model row carries its true duration; gaps never become invented energy.
    model = sorted((int(parse_timestamp(row["timestamp"]).timestamp()),
                    int(row.get("interval_minutes", model_minutes)*60), row["energy_kwh"]*sale_factor) for row in model_rows)
    starts = [row[0] for row in model]

    def integrated_model(begin, end):
        total = 0.0
        cursor = begin
        while cursor < end:
            index = bisect_right(starts, cursor)-1
            if index < 0:
                return None
            stamp, seconds, energy = model[index]
            if seconds <= 0 or cursor >= stamp+seconds:
                return None
            piece_end = min(end, stamp+seconds)
            total += energy*(piece_end-cursor)/seconds
            cursor = piece_end
        return total

    monthly_model = defaultdict(float)
    month_years = set()
    for stamp, seconds, energy in model:
        cursor = datetime.fromtimestamp(stamp, TIMEZONE)
        end = cursor+timedelta(seconds=seconds)
        while cursor < end:
            boundary = datetime(cursor.year+(cursor.month == 12), cursor.month % 12+1, 1, tzinfo=TIMEZONE)
            piece_end = min(end, boundary)
            key = cursor.strftime("%Y-%m")
            monthly_model[key] += energy*(piece_end-cursor).total_seconds()/seconds
            month_years.add(key)
            cursor = piece_end
    monthly_actual = defaultdict(float)
    monthly_matched = defaultdict(float)
    monthly_valid = Counter()
    processed = []
    outside = 0
    for item in parsed:
        start = item["start"]
        matched = item["valid"] and start is not None
        if matched:
            matched = integrated_model(int(start.timestamp()), int(start.timestamp())+interval_minutes*60) is not None
            if not matched:
                outside += 1
        if matched:
            # Split intervals crossing month boundaries; both measured and model energy are prorated.
            cursor = start
            end_time = start + duration
            while cursor < end_time:
                next_month = datetime(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1, tzinfo=TIMEZONE)
                piece_end = min(end_time, next_month)
                ratio = (piece_end-cursor).total_seconds()/duration.total_seconds()
                key = cursor.strftime("%Y-%m")
                monthly_actual[key] += item["energy_kwh"] * ratio
                monthly_matched[key] += integrated_model(int(cursor.timestamp()), int(piece_end.timestamp()))
                monthly_valid[key] += ratio
                cursor = piece_end
        processed.append({"source_row": item["source_row"], "plant_id": item["plant_id"], "timestamp": start.isoformat() if start else None,
                          "energy_kwh": item["energy_kwh"], "valid": item["valid"], "model_matched": bool(matched), "reasons": item["reasons"]})
    monthly = []
    for key in sorted(month_years):
        year, month = map(int, key.split("-"))
        expected = calendar.monthrange(year, month)[1]*1440/interval_minutes
        ratio = min(1, monthly_valid[key]/expected)
        actual = monthly_actual[key] if monthly_valid[key] else None
        matched_value = monthly_matched[key] if monthly_valid[key] else None
        eligible = compatible and ratio >= .8 and actual is not None and actual > 0
        difference = matched_value-actual if actual is not None and compatible else None
        error = difference/actual*100 if eligible else None
        monthly.append({"month": month, "period": key, "actual_kwh": actual, "model_kwh": monthly_model[key],
                        "model_matched_kwh": matched_value, "difference_kwh": difference,
                        "relative_error_pct": error, "error_pct": error, "valid_ratio": ratio,
                        "direction": "과대" if error is not None and error > 0 else "과소" if error is not None and error < 0 else "일치" if error == 0 else "산정 불가"})
    valid = sum(item["valid"] for item in parsed)
    diagnostics["outside_model_period"] = outside
    diagnostics["missing_intervals"] = sum(max(0, round(calendar.monthrange(int(key[:4]), int(key[5:]))[1]*1440/interval_minutes-monthly_valid[key])) for key in month_years)
    warnings.append("상대오차는 월 유효자료 80% 이상·실적 0 초과일 때 동일 시각의 모델 구간과 비교합니다.")
    return {"kind": kind, "measurement": measurement, "unit": unit, "timezone": "Asia/Seoul",
            "timestamp_semantics": "end" if measurement == "cumulative" else timestamp_semantics,
            "interval_minutes": interval_minutes, "row_count": len(rows), "valid_rows": valid,
            "valid_ratio": valid/len(rows), "compatible": compatible, "diagnostics": dict(diagnostics),
            "warnings": warnings, "monthly": monthly, "processed": processed,
            "comparison_basis": "동일 시각의 유효 구간; 모델-실적, 상대오차=(모델-실적)/실적×100"}
