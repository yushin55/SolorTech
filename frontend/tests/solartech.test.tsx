import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SolarTech from "../src/SolarTech";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(onImport = vi.fn().mockResolvedValue(undefined)) {
  const base = { id: "a", name: "검토 발전소", original_name: "원본 이름", address: "서귀포시", provider: "출처",
    source_sheet: "시트1", source_row: 3, latitude: 33.3, longitude: 126.2, has_coordinates: true,
    capacity_kw: 100, module_power_w: 250, module_power_raw: 250, module_count: 400, tilt_deg: 25, tilt_raw: 25,
    inverter_capacity_raw: "50kW x 2EA", inverter_count: null, calculated_module_capacity_kw: 100,
    capacity_difference_kw: 0, capacity_mismatch: false, generation_file: "file.csv", generation_file_referenced: true,
    issues: ["설치장소 유형 미입력"], raw: { "통합 발전소명": "검토 발전소", "모듈 방향": null } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    source_file: "source.xlsx", assets: [base, { ...base, id: "b", name: "용량 오류", address: "부산시", capacity_mismatch: true, capacity_difference_kw: 15 }],
    summary: { plants: 2, with_coordinates: 2, generation_references: 2, capacity_mismatches: 1 }, generation_note: "시계열 미포함",
  }), { status: 200 })));
  render(<SolarTech onImport={onImport} />);
  return onImport;
}

it("searches by address and filters capacity discrepancies", async () => {
  setup();
  await screen.findByText("2곳 표시");
  fireEvent.change(screen.getByLabelText("발전소 검색"), { target: { value: "부산" } });
  expect(screen.getByText("1곳 표시")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "검토 발전소" })).toBeNull();
  fireEvent.change(screen.getByLabelText("발전소 검색"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("표시 조건"), { target: { value: "mismatch" } });
  expect(screen.getByRole("button", { name: "용량 오류" })).toBeTruthy();
  expect(screen.getByText("차이 15.000 kW")).toBeTruthy();
});

it("prefills source values and sends confirmed conditions with an explicit site type", async () => {
  const onImport = setup();
  fireEvent.click(await screen.findByRole("button", { name: "사업성 검토로 가져오기" }));
  expect(screen.getByLabelText("설치장소 유형").getAttribute("required")).not.toBeNull();
  expect((screen.getByLabelText("설치장소 유형") as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("설치장소 유형"), { target: { value: "land" } });
  fireEvent.click(screen.getByRole("button", { name: "확인한 조건으로 가져오기" }));
  await waitFor(() => expect(onImport).toHaveBeenCalledWith("a", { site_type: "land", latitude: 33.3, longitude: 126.2,
    capacity_kw: 100, module_power_w: 250, tilt: 25, azimuth: 180 }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps confirmed inputs visible after an import error", async () => {
  const onImport = setup(vi.fn().mockRejectedValue(new Error("저장 실패")));
  fireEvent.click(await screen.findByRole("button", { name: "사업성 검토로 가져오기" }));
  fireEvent.change(screen.getByLabelText("설치장소 유형"), { target: { value: "rooftop" } });
  fireEvent.click(screen.getByRole("button", { name: "확인한 조건으로 가져오기" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "저장 실패");
  expect(onImport).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("설치장소 유형") as HTMLSelectElement).value).toBe("rooftop");
});
