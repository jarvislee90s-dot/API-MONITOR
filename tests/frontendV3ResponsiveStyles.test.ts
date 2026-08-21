import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "frontend/src/styles.css"), "utf8");

function blockFor(selector: string): string {
  const match = styles.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("frontend-v3 responsive dashboard styles", () => {
  it("aligns hero, summary, and provider rows on the same responsive rail", () => {
    const appShellInner = blockFor(".app-shell__inner");
    const hero = blockFor(".hero");
    const summaryBar = blockFor(".summary-bar");
    const dashboardGrid = blockFor(".dashboard-grid");

    expect(appShellInner).toContain("--content-rail-width: min(1960px, calc(100vw - clamp(32px, 4vw, 88px)))");
    expect(appShellInner).toContain("--content-rail-offset: calc(50% - (var(--content-rail-width) / 2))");
    expect(hero).toContain("width: var(--content-rail-width)");
    expect(hero).toContain("margin-left: var(--content-rail-offset)");
    expect(summaryBar).toContain("width: var(--content-rail-width)");
    expect(summaryBar).toContain("max-width: 1960px");
    expect(summaryBar).toContain("margin-left: var(--content-rail-offset)");
    expect(dashboardGrid).toContain("width: var(--content-rail-width)");
    expect(dashboardGrid).toContain("max-width: 1960px");
    expect(dashboardGrid).toContain("margin-left: var(--content-rail-offset)");
    expect(dashboardGrid).not.toContain("transform: translateX(-50%)");
  });

  it("keeps provider cards readable while flowing between one and three columns", () => {
    const dashboardGrid = blockFor(".dashboard-grid");

    expect(dashboardGrid).toContain("grid-template-columns: repeat(auto-fit, minmax(min(100%, 620px), 1fr))");
    expect(dashboardGrid).toContain("gap: clamp(18px, 2vw, 32px)");
  });

  it("switches provider cards to a single wide column when the viewport is cramped by high zoom", () => {
    expect(styles).toContain("@media (max-width: 1320px)");
    expect(styles).toContain(".dashboard-grid { grid-template-columns: 1fr; }");
    expect(styles).toContain(".platform-card { min-height: clamp(340px, 34vw, 520px); }");
  });

  it("keeps provider cards elastic instead of locking a fixed ratio or scrollbars", () => {
    const platformCard = blockFor(".platform-card");
    const quotaList = blockFor(".quota-list");
    const summary = blockFor(".platform-card__summary");

    expect(platformCard).toContain("container-type: inline-size");
    expect(platformCard).not.toContain("aspect-ratio");
    expect(platformCard).not.toContain("overflow-y: auto");
    expect(quotaList).not.toContain("overflow-y: auto");
    expect(summary).toContain("-webkit-line-clamp: 2");
  });
});
