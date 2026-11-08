/**
 * CarbonWMS Email — render an email the way customers see it (step 5 of the
 * six steps, owner 2026-11-08): the finished HTML in a headless Chromium at the
 * desktop column width (640 px window, 2× sharp) and at a phone width (375 px,
 * 2×), full-page screenshots for the visual review.
 *
 * Chromium: the server image installs Alpine's chromium (CHROMIUM_PATH,
 * default /usr/bin/chromium-browser); on a developer machine Playwright's own
 * browser is used.
 */
import { existsSync } from "node:fs";

export async function renderEmail(html: string): Promise<{ desktop: Buffer; phone: Buffer }> {
  const { chromium } = await import("playwright-core");
  const path = [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p));
  const browser = await chromium.launch({
    ...(path ? { executablePath: path } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const shot = async (width: number, isMobile: boolean) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, isMobile, hasTouch: isMobile, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
      // Pictures come from the internet: give slow ones a moment.
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      const png = await page.screenshot({ fullPage: true, type: "png" });
      await ctx.close();
      return png;
    };
    const desktop = await shot(640, false);
    const phone = await shot(375, true);
    return { desktop, phone };
  } finally {
    await browser.close().catch(() => {});
  }
}
