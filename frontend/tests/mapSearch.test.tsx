import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MapSearch from "../src/MapSearch";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const location = {
  id: "suwon",
  label: "경기도 수원시",
  latitude: 37.2636,
  longitude: 127.0286,
  bbox: [126.94, 37.18, 127.12, 37.35],
  source: "local",
  kind: "region",
};
it("searches only on submit and passes the selected region viewport to the map", async () => {
  const user = userEvent.setup(),
    select = vi.fn(),
    fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [location],
            provider: "local",
            warning: null,
            attribution: "지역 중심점",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<MapSearch onSelect={select} />);
  await user.type(
    screen.getByRole("textbox", { name: "지도 지역 검색" }),
    "수원시",
  );
  expect(fetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "검색", exact: true }));
  await user.click(
    await screen.findByRole("button", { name: /경기도 수원시/ }),
  );
  expect(fetch.mock.calls[0][0]).toContain(encodeURIComponent("수원시"));
  expect(select).toHaveBeenCalledWith(location);
  expect(screen.queryByRole("list")).toBeNull();
});
it("keeps the viewport unchanged when no region matches", async () => {
  const user = userEvent.setup(),
    select = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [],
            provider: "local",
            warning: null,
            attribution: "",
          }),
        ),
    ),
  );
  render(<MapSearch onSelect={select} />);
  await user.type(
    screen.getByRole("textbox", { name: "지도 지역 검색" }),
    "모르는 지역",
  );
  await user.click(screen.getByRole("button", { name: "검색", exact: true }));
  await screen.findByText(/검색 결과가 없습니다/);
  expect(select).not.toHaveBeenCalled();
});
it("allows retry after a failed request and clears the previous error", async () => {
  const user = userEvent.setup(),
    select = vi.fn(),
    fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("연결 실패"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [location],
            provider: "local",
            warning: null,
            attribution: "",
          }),
        ),
      );
  vi.stubGlobal("fetch", fetch);
  render(<MapSearch onSelect={select} />);
  await user.type(
    screen.getByRole("textbox", { name: "지도 지역 검색" }),
    "수원",
  );
  await user.click(screen.getByRole("button", { name: "검색", exact: true }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "검색", exact: true }));
  await screen.findByRole("button", { name: /경기도 수원시/ });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
