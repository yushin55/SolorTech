import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import GenerationRecords from "../src/GenerationRecords";
import type { GenerationCatalog } from "../src/GenerationRecords";
import type { Run } from "../src/types";

vi.mock("recharts", () => Object.fromEntries(["Bar", "BarChart", "CartesianGrid", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis"].map((name) => [name, ({ children }: { children?: React.ReactNode }) => <div>{children}</div>])));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture() {
  const catalog: GenerationCatalog = { archive_file: "archive.zip", imported_at: "2026-11-16", training_note: "보정 학습 자동 추가 안 함", unit_basis: "단위 가정",
    summary: { added_files: 1, duplicate_files: 35, source_csv_files: 1, series: 1, linked_assets: 1, daily_records: 31, monthly_records: 0, conflicting_rows: 0 },
    series: [{ id: "series", name: "연결 발전소", unit_id: "1", resolution: "daily", asset_ids: ["asset"], records: 31,
      first: "2025-01-01", last: "2025-01-31", source_files: ["source.csv"], value_header: "총량(kw)", issues: [], capacity_mismatch: false,
      match_basis: "파일명 + 호기", unit_basis: "kWh 해석 가정", source_url: null, diagnostics: { incomplete_hours: 1 },
      months: [{ period: "2025-01", total_value: 0, records: 31, valid_records: 31, coverage: 1, flagged_records: 1, zero_records: 31 }] }],
  };
  const run = { id: "run", status: "completed", created_at: "2026-11-16T00:00:00Z", snapshot: { candidate: { name: "연결 발전소", solartech_asset_id: "asset" }, design: { name: "기준안" } } } as unknown as Run;
  const fetcher = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("/compare") ? {
    run_id: "run", series_id: "series", year: 2025, compatible: true, excluded_records: 0, warnings: ["단위 가정"], monthly: [],
  } : { records: [{ period: "2025-01-01", value: 0, hours: [...Array(23).fill(0), null], flags: ["incomplete_hours"], source_refs: [{ source_file: "source.csv", row: 2 }] }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  return { catalog, run, fetcher };
}

it("shows original units, zero data and missing-hour diagnostics", async () => {
  const { catalog } = fixture();
  render(<GenerationRecords catalog={catalog} assetId="asset" runs={[]} />);
  expect(await screen.findByText("2025-01-01")).toBeTruthy();
  expect(screen.getByText(/원본 항목: 총량\(kw\)/)).toBeTruthy();
  expect(screen.getByText(/시간별 결측 \(일 총량 보존\) 1행/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "저장 실적과 대조" })).toBeNull();
});

it("requires the unit assumption before comparing a linked completed run", async () => {
  const { catalog, run, fetcher } = fixture();
  render(<GenerationRecords catalog={catalog} assetId="asset" runs={[run]} />);
  await screen.findByText("2025-01-01");
  fireEvent.click(screen.getByText("완료된 설계안과 같은 기간의 실적 대조"));
  const compare = screen.getByRole("button", { name: "저장 실적과 대조" });
  expect((compare as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(compare);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/solartech/generation/series/compare", expect.objectContaining({
    method: "POST", body: JSON.stringify({ run_id: "run", year: 2025, assume_kwh: true }),
  })));
  expect(await screen.findByText(/실적과 같은 날짜의 기상으로 다시 계산/)).toBeTruthy();
});

it("keeps unlinked plant records readable without offering a model comparison", async () => {
  const { catalog, run } = fixture();
  catalog.series[0].asset_ids = [];
  catalog.series[0].issues = ["호기 연결 확인 필요"];
  render(<GenerationRecords catalog={catalog} assetId="asset" runs={[run]} />);
  expect(await screen.findByText("호기 연결 확인 필요")).toBeTruthy();
  expect(screen.getByText(/현재 선택 발전소에 자동 연결된 자료가 아닙니다/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "저장 실적과 대조" })).toBeNull();
});
