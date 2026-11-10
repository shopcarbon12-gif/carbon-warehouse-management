/**
 * Radar — a polite headless Chromium for the public ad-library pages that have no API.
 * It reads the JSON the page itself loads (more stable than the obfuscated DOM), waits between
 * pages (rate limit), backs off on 429 / "try again later", and stops at a hard page budget.
 */
import { existsSync } from "node:fs";

export type Captured = { url: string; json: unknown };

export async function withBrowser<T>(fn: (open: (url: string, opts?: { scrolls?: number; matchUrl?: RegExp; waitMs?: number }) => Promise<{ captured: Captured[]; html: string }>) => Promise<T>): Promise<T> {
  const { chromium } = await import("playwright-core");
  const exe = [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p));
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  let lastOpen = 0;
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    });
    const open = async (url: string, opts: { scrolls?: number; matchUrl?: RegExp; waitMs?: number } = {}) => {
      const gap = Date.now() - lastOpen;
      if (gap < 4000) await new Promise((r) => setTimeout(r, 4000 - gap)); // ≥ 4 s between pages
      lastOpen = Date.now();
      const page = await ctx.newPage();
      const captured: Captured[] = [];
      page.on("response", async (res) => {
        try {
          if (opts.matchUrl && !opts.matchUrl.test(res.url())) return;
          const ct = res.headers()["content-type"] ?? "";
          if (!/json|javascript|text\/plain/.test(ct)) return;
          const text = await res.text();
          for (const chunk of text.split(/\n(?=\{)/)) {
            const t = chunk.trim().replace(/^for \(;;\);/, "");
            if (!t.startsWith("{") && !t.startsWith("[")) continue;
            try {
              captured.push({ url: res.url(), json: JSON.parse(t) });
            } catch {
              /* not JSON */
            }
          }
        } catch {
          /* body gone */
        }
      });
      let tries = 0;
      for (;;) {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
        if (res && res.status() === 429 && tries < 2) {
          tries++;
          await new Promise((r) => setTimeout(r, 15_000 * tries)); // back off
          continue;
        }
        break;
      }
      await page.waitForTimeout(opts.waitMs ?? 3500);
      for (let i = 0; i < (opts.scrolls ?? 3); i++) {
        await page.mouse.wheel(0, 2400);
        await page.waitForTimeout(1800);
      }
      const html = await page.content().catch(() => "");
      await page.close().catch(() => {});
      return { captured, html };
    };
    return await fn(open);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Every object anywhere in `root` for which `pick` returns true (deduped by reference). */
export function findObjects(root: unknown, pick: (o: Record<string, unknown>) => boolean, max = 2000): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || seen.has(o) || depth > 40 || out.length >= max) return;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    const r = o as Record<string, unknown>;
    if (pick(r)) out.push(r);
    for (const v of Object.values(r)) walk(v, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** JSON objects embedded in the page's own <script> tags (server-rendered first page). */
export function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const s = m[1].trim();
    if (!s.startsWith("{") && !s.startsWith("[")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* not JSON */
    }
  }
  return out;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const dateOf = (v: unknown): string | null => {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e9) return new Date(n > 1e12 ? n : n * 1000).toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};
