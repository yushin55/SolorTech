"""Raw K-water file parsing and daily quality-control rules."""

import pandas as pd
import pytest

from app import calibration, kwater

REPORT = """<html><head><meta charset="euc-kr"></head><body><table>
<tr><td><span class="style1">아산정수장 2차발전설비</span></td></tr>
<tr><td><div class="style1">발전년월 : <b>2024년2월</b></div></td></tr>
<tr><td><div class="style1">전체발전용량 : 2132.10kWp</b></div></td></tr>
{rows}
</table></body></html>"""
ROW = """<tr><td width="110" height="30" align="center"><b>{day:02d}</b></td>
<td width="110" align="right"><b>{kwh}</b></td>
<td width="110" align="right"><b>0.0</b></td>
<td width="110" align="right"><b>0.0</b></td><td></td></tr>"""


def test_asan_html_report_is_parsed_and_duplicates_skipped(tmp_path):
    rows = "".join(ROW.format(day=day, kwh=kwh) for day, kwh in [(1, "8,947.0"), (2, "0.0"), (3, "20,195.0")])
    (tmp_path / "월간보고서_202402.xls").write_bytes(REPORT.format(rows=rows).encode("cp949"))
    (tmp_path / "월간보고서_202402 (2).xls").write_bytes(REPORT.format(rows=rows).encode("cp949"))
    capacity, parsed = kwater.parse_asan_reports(str(tmp_path))
    assert capacity == pytest.approx(2132.1)
    assert [(row["date"], row["kwh"]) for row in parsed] == [
        ("2024-02-01", 8947.0), ("2024-02-02", 0.0), ("2024-02-03", 20195.0)]
    assert [kwater.daily_flag(row["kwh"], capacity) for row in parsed] == ["ok", "zero", "spike"]
    assert kwater.daily_flag(None, capacity) == "missing"


def test_ratio_models_and_selection_rule():
    train = pd.DataFrame({"plant_id": ["a", "a", "b", "b"], "month": [1, 2, 1, 2], "ratio": [.8, .9, 1., 1.1]})
    held = pd.DataFrame({"month": [1, 2, 3]})
    assert list(calibration.RatioModel("physics", train).predict(held)) == [1, 1, 1]
    median = calibration.RatioModel("monthly_median", train).predict(held)
    assert median == pytest.approx([.9, 1., .95])
    results = {"physics": {"floating": {"mape_pct": 10}, "all": {"mape_pct": 15}},
               "gbr": {"floating": {"mape_pct": 12}, "all": {"mape_pct": 9}}}
    assert calibration.select_model(results) == "physics"
    results["gbr"]["floating"]["mape_pct"] = 8
    assert calibration.select_model(results) == "gbr"


DAILY = """#START7777
# YYMMDD STN    TA      TA      TA      TA      TA      HM      HM      HM      CA      SS      SS       SI       SI
20230401,108,17.5,25.6,1525,9.4,646,40.4,19.0,1528,1.8,10.8,12.6,21.48,3.05,
20230402,108,18.8,25.2,1505,11.9,617,29.6,16.0,1253,0.4,11.7,12.6,-9.0,3.36,
#7777END
"""
NORMALS = """# ST,STN, MM,    TA,TA_MAX,TA_MIN,    HM,    SS,CA_TOT,=
""" + "".join(f"2021,232, {m:2d},  -2.4,   3.0,  -7.5,  68.5, 167.2, -99.9,=\n" for m in range(1, 13))


def test_kma_daily_and_normals_are_parsed(tmp_path):
    from app import kma

    (tmp_path / "daily.csv").write_text(DAILY, encoding="cp949")
    (tmp_path / "normals.csv").write_text(NORMALS, encoding="cp949")
    daily = kma.parse_daily(tmp_path / "daily.csv")
    assert list(daily.date) == ["2023-04-01", "2023-04-02"]
    assert daily.si_day.iloc[0] == pytest.approx(21.48) and pd.isna(daily.si_day.iloc[1])
    normals = kma.parse_normals(tmp_path / "normals.csv")
    assert len(normals) == 12 and normals.period.iloc[0] == "1991~2020"
    assert normals.ss_hours.iloc[0] == pytest.approx(167.2) and pd.isna(normals.ca_tot.iloc[0])


def test_irradiance_scaling_by_calendar_month():
    from app import weather

    index = pd.date_range("2024-07-01", periods=2, freq="h", tz="Asia/Seoul")
    frame = pd.DataFrame({"ghi": [100., 200.], "dni": [50., 50.], "dhi": [10., 10.], "temp_air": [25., 25.],
                          "wind_speed": [1., 1.]}, index=index)
    scaled = weather.scale_irradiance(frame, {"7": .9})
    assert list(scaled.ghi) == pytest.approx([90, 180]) and list(scaled.temp_air) == [25, 25]
    assert weather.scale_irradiance(frame, None) is frame
