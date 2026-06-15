import { describe, expect, it } from "vitest";
import { formatPreviewValue } from "../../frontend/src/settings/credential-preview";

describe("formatPreviewValue", () => {
  it("returns the value unchanged when it fits in the max length", () => {
    expect(formatPreviewValue("sk-or...937d")).toBe("sk-or...937d");
    expect(formatPreviewValue("")).toBe("");
    expect(formatPreviewValue("a".repeat(28))).toBe("a".repeat(28));
  });

  it("truncates long values with head and tail segments", () => {
    const longUrl = "https://maas.xfyun.cn/packageSubscription";
    const result = formatPreviewValue(longUrl);
    expect(result.length).toBeLessThan(longUrl.length);
    expect(result).toContain("…");
    expect(result.startsWith("https://ma")).toBe(true);
    expect(result.endsWith("bscription")).toBe(true);
  });

  it("masks OpenRouter API keys consistently with the rest of the app", () => {
    // Real OpenRouter keys are 73 chars: sk-or-v1- + 64 hex chars
    const apiKey = "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";
    const result = formatPreviewValue(apiKey);
    expect(result).toBe("sk-or-v1-fa3…b187d354937d");
  });
});
