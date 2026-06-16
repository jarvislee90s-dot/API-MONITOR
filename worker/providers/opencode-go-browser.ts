import puppeteer from "@cloudflare/puppeteer";
import { parseHeadersCookie } from "../http";
import type { OpenCodeBrowserRenderInput } from "../types";

function normalizeCookieHeader(rawCookie: string | undefined): string | undefined {
  const cookie = parseHeadersCookie(rawCookie);
  if (!cookie) return undefined;
  return cookie.includes("=") ? cookie : `auth=${cookie}`;
}

function toPageCookies(rawCookie: string | undefined, sourceUrl: string): Array<{ name: string; value: string; url: string }> {
  const cookie = normalizeCookieHeader(rawCookie);
  if (!cookie) return [];

  return cookie
    .split(";")
    .map((part) => part.trim())
    .flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return [];
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1);
      if (!name || name.includes(";")) return [];
      return [{ name, value, url: sourceUrl }];
    });
}

export async function renderOpenCodeGoBrowserHtml(input: OpenCodeBrowserRenderInput): Promise<string> {
  if (!input.browser) {
    throw new Error("OpenCode Browser Run binding is not configured");
  }

  const browser = await puppeteer.launch(input.browser);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );

    const cookies = toPageCookies(input.authCookie, input.sourceUrl);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    await page.goto(input.sourceUrl, { waitUntil: "networkidle0", timeout: 20_000 });
    await page.waitForFunction(
      () => document.documentElement.innerHTML.includes("rollingUsage") || document.body.innerText.includes("滚动用量"),
      { timeout: 10_000 },
    ).catch(() => undefined);

    return await page.content();
  } finally {
    await browser.close();
  }
}
