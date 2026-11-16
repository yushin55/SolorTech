import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GUIDES, GuidePanel } from "../src/Guide";
import type { GuideKey } from "../src/Guide";

afterEach(cleanup);

it("has a guide for every wizard step and page, and closes on Escape", () => {
  for (const key of Object.keys(GUIDES) as GuideKey[]) {
    const { unmount } = render(<GuidePanel guideKey={key} where="위치" title={key} onClose={vi.fn()} onOpenHelp={vi.fn()} />);
    expect(screen.getByText("이 화면에서 하는 일")).toBeTruthy();
    unmount();
  }
  const onClose = vi.fn();
  render(<GuidePanel guideKey="step1" where="사업성 검토 · 1단계 / 6" title="1단계" onClose={onClose} onOpenHelp={vi.fn()} />);
  expect(screen.getByText(/이 위치를 후보지로 등록/)).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("complementary", { name: "도우미" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
