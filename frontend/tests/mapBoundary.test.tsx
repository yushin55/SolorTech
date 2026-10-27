import React, { Suspense, lazy, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MapBoundary from "../src/MapBoundary";

function BrokenMap(): React.ReactNode {
  throw new Error("The map module could not be loaded");
}

beforeEach(() => {
  // React reports errors caught by a boundary; these failures are intentional.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("map loading recovery", () => {
  it("keeps the home screen usable when the map fails to render", () => {
    render(
      <main>
        <h1>태양광 사업성 분석</h1>
        <MapBoundary>
          <BrokenMap />
        </MapBoundary>
        <button>후보지 추가</button>
      </main>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "지도를 불러오지 못했습니다" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "태양광 사업성 분석" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "후보지 추가" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "지도 다시 불러오기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "화면 새로고침" })).toBeTruthy();
  });

  it("catches an asynchronously rejected lazy map import", async () => {
    const BrokenLazyMap = lazy(() =>
      Promise.reject(new Error("504 (Outdated Optimize Dep)")),
    );

    render(
      <MapBoundary>
        <Suspense fallback={<p>지도 준비 중</p>}>
          <BrokenLazyMap />
        </Suspense>
      </MapBoundary>,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "지도를 불러오지 못했습니다" }),
    ).toBeTruthy();
    expect(screen.queryByText("지도 준비 중")).toBeNull();
  });

  it("clears the failure and asks the parent to load a fresh map on retry", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();

    function RecoverableMap() {
      const [ready, setReady] = useState(false);
      return (
        <MapBoundary
          onRetry={() => {
            retry();
            setReady(true);
          }}
        >
          {ready ? <p>지도 표시 완료</p> : <BrokenMap />}
        </MapBoundary>
      );
    }

    render(<RecoverableMap />);
    await user.click(screen.getByRole("button", { name: "지도 다시 불러오기" }));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("지도 표시 완료")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
