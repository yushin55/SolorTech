"""Small input checks shared by calculation engines (independent of API schemas)."""

from math import isfinite


ENGINE_VERSION = "1.0.0"
TIMEZONE = "Asia/Seoul"


def number(values, key, default=None, minimum=None, maximum=None):
    value = values.get(key, default)
    if value is None or isinstance(value, bool):
        raise ValueError(f"{key}: 유한한 숫자가 필요합니다.")
    try:
        value = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{key}: 숫자가 필요합니다.") from exc
    if not isfinite(value):
        raise ValueError(f"{key}: 유한한 숫자가 필요합니다.")
    if minimum is not None and value < minimum:
        raise ValueError(f"{key}: {minimum} 이상이어야 합니다.")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key}: {maximum} 이하여야 합니다.")
    return value


def integer(values, key, default=None, minimum=None, maximum=None):
    value = number(values, key, default, minimum, maximum)
    if not value.is_integer():
        raise ValueError(f"{key}: 정수가 필요합니다.")
    return int(value)


def capacities(equipment):
    count = integer(equipment, "module_count", minimum=0, maximum=100000)
    power = number(equipment, "module_power_w", minimum=1, maximum=2000)
    dc = power * count / 1000
    ac = number(equipment, "ac_capacity_kw", default=dc / 1.15, minimum=0)
    if count > 0 and ac <= 0:
        raise ValueError("ac_capacity_kw: 모듈이 있으면 AC 용량은 0보다 커야 합니다.")
    return dc, ac
