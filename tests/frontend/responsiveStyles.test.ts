import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "frontend/src/styles.css"), "utf8");

function blockFor(selector: string): string {
  const match = styles.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function mediaBlockFor(query: string): string {
  const start = styles.indexOf(`@media (${query})`);
  if (start === -1) return "";

  const firstBrace = styles.indexOf("{", start);
  let depth = 0;
  for (let index = firstBrace; index < styles.length; index += 1) {
    const char = styles[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return styles.slice(firstBrace + 1, index);
  }

  return "";
}

describe("frontend responsive dashboard styles", () => {
  it("keeps provider cards responsive from desktop to mobile", () => {
    expect(blockFor(".dashboard-grid")).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 620px), 1fr))",
    );
    expect(mediaBlockFor("max-width: 1320px")).toContain(
      ".dashboard-grid { grid-template-columns: 1fr; }",
    );
    expect(mediaBlockFor("max-width: 720px")).toContain(
      ".dashboard-grid { grid-template-columns: 1fr; }",
    );
  });
});
