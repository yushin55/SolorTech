import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Regulations from "../src/Regulations";
import type { RegulationTarget } from "../src/Regulations";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const layers = [
  { id: "water", label: "상수원보호구역", color: "#ef4444" },
  { id: "park", label: "국립공원", color: "#15803d" },
];
const target: RegulationTarget = {
  name: "선택 건축물", latitude: 37.3, longitude: 127,
  geometry: { type: "Polygon", coordinates: [[[127, 37.3], [127.001, 37.3], [127.001, 37.301], [127, 37.3]]] },
};
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("official restriction checks", () => {
  it("labels missing credentials as unverified and does not request upstream map data", async () => {
    const fetch = vi.fn(async () => response({ configured: false, layers, notice: "경기도 제공 범위" }));
    vi.stubGlobal("fetch", fetch);
    render(<Regulations map={null} target={target} />);
    await screen.findByText("규제요인 2종 · 표시 설정");
    expect(screen.getByText(/규제자료 미연결/)).toBeTruthy();
    expect(screen.queryByText("조회 자료 내 중첩 없음")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks the whole polygon, preserves unknown layers, and checks all layers when display is disabled", async () => {
    const fetch = vi.fn(async (url: string) => response(url.endsWith("/catalog")
      ? { configured: true, layers, notice: "경기도 제공 범위" }
      : { status: "partial", basis: "후보지 전체 경계", warning: "일부 자료 미확인",
          items: [{ ...layers[0], status: "overlap" }, { ...layers[1], status: "unknown" }] }));
    vi.stubGlobal("fetch", fetch);
    render(<Regulations map={null} target={target} />);
    await screen.findByText("1개 규제요인 중첩 · 인허가 검토 필요");
    const call = fetch.mock.calls.find(([url]) => url.endsWith("/check")) as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual(target);
    expect(screen.getByText("미확인 1개 항목")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "규제지역 표시" }));
    expect(screen.getByText("1개 규제요인 중첩 · 인허가 검토 필요")).toBeTruthy();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/check"))).toHaveLength(1);
    expect(screen.queryByText("조회 자료 내 중첩 없음")).toBeNull();
  });

  it("discards a late response for a previously selected site", async () => {
    let finishOld: ((value: Response) => void) | undefined;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/catalog")) return Promise.resolve(response({ configured: true, layers, notice: "경기도 제공 범위" }));
      const body = JSON.parse(String(init?.body));
      if (body.name === target.name) return new Promise<Response>((resolve) => { finishOld = resolve; });
      return Promise.resolve(response({ status: "partial", items: layers.map((layer) => ({ ...layer, status: "unknown" })) }));
    });
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<Regulations map={null} target={target} />);
    await waitFor(() => expect(finishOld).toBeDefined());
    rerender(<Regulations map={null} target={{ ...target, name: "새 부지" }} />);
    await screen.findByText("미확인 2개 항목");
    finishOld!(response({ status: "complete", items: layers.map((layer) => ({ ...layer, status: "clear" })) }));
    await waitFor(() => expect(screen.getByText("새 부지 규제 확인")).toBeTruthy());
    expect(screen.queryByText("조회 자료 내 중첩 없음")).toBeNull();
  });
});
