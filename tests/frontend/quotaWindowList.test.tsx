import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuotaWindowList } from "../../frontend/src/components/quota-window-list";
import type { QuotaWindow } from "../../frontend/src/api/client";

// chatgpt「仅 Codex 窗口」时 api client 追加的形态：真实 codex 窗口 + web 桶占位说明行
const codexWindow: QuotaWindow = {
  label: "Codex 30天",
  scope: "Codex 编码额度",
  used: 100,
  limit: 100,
  percentUsed: 100,
  resetAt: "滚动窗口",
  status: "healthy",
};

const webNoteWindow: QuotaWindow = {
  label: "网页对话额度",
  scope: "网页对话额度",
  bucket: "web",
  note: "与 Codex 编码额度独立计量，Codex 用尽不影响网页聊天；该额度接口未对外提供（免费与 Plus 档实测均返回 404）",
  used: 0,
  limit: 0,
  percentUsed: null,
  resetAt: "",
  status: "healthy",
};

describe("QuotaWindowList 额度桶占位说明行", () => {
  it("note 行显示桶标题与说明文案", () => {
    render(<QuotaWindowList windows={[codexWindow, webNoteWindow]} />);

    expect(screen.getByText("网页对话额度")).toBeTruthy();
    expect(screen.getByText(/与 Codex 编码额度独立计量/)).toBeTruthy();
  });

  it("note 行不渲染进度条与数值，真实窗口仍渲染进度条", () => {
    const { container } = render(<QuotaWindowList windows={[codexWindow, webNoteWindow]} />);

    const noteRow = container.querySelector(".quota-row--note");
    expect(noteRow).toBeTruthy();
    // 说明行内无进度条、无数值、无重置时间脚注
    expect(noteRow?.querySelector(".progress")).toBeNull();
    expect(noteRow?.querySelector(".quota-row__value")).toBeNull();
    expect(noteRow?.querySelector(".quota-row__foot")).toBeNull();
    // 整个列表只剩真实窗口的一条进度条
    expect(container.querySelectorAll(".progress")).toHaveLength(1);
  });
});
