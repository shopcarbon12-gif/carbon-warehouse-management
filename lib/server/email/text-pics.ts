/**
 * CarbonWMS Email Editor — "Send as a picture" headlines (owner, 2026-11-09).
 *
 * Gmail and Outlook for Windows ignore web fonts, so a Bodoni or Bebas headline shows up as Georgia
 * or Arial there. A text block switched to "Send as a picture" is drawn once here, in the same
 * headless Chromium the server already has (lib/server/email/render.ts), at 2× for sharp phones,
 * and the email sends it as an <img> with the words in its alt text.
 *
 * Pictures are keyed by a hash of the drawing page (render.ts picSources), stored once in
 * email_text_pics and shared by every email that uses the same headline. Saving an email never
 * waits for Chromium: it uses the pictures that exist (text stands in for the rest) and draws the
 * missing ones in the background; preview, test sends, translation and campaign approval wait for
 * them (ensureEditorPics), so nothing goes out with a stand-in by accident.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { uploadBytesToStorage } from "@/lib/storageProvider";
import { hashKey, picKey, picPage, picSources, plainText, type Pic, type PicSource } from "@/lib/email-editor/render";
import { isDoc, type EmailDoc } from "@/lib/email-editor/types";
import { WMS_BASE } from "./config";

const MAX_PER_RUN = 16;
// Hero pictures load their photos from Shopify/R2; give them time.

/** Where pictures are stored (R2); the tests swap in a fake so they never write to the real bucket. */
let put: typeof uploadBytesToStorage = uploadBytesToStorage;
export function setPicStorageForTests(fn: typeof uploadBytesToStorage): void {
  put = fn;
}

export async function loadPics(pool: Pool, keys: string[]): Promise<Record<string, Pic>> {
  if (!keys.length) return {};
  const r = await pool
    .query<{ key: string; url: string; width: number; height: number }>(`SELECT key, url, width, height FROM email_text_pics WHERE key = ANY($1::text[])`, [keys])
    .catch(() => ({ rows: [] as { key: string; url: string; width: number; height: number }[] }));
  return Object.fromEntries(r.rows.map((x) => [x.key, { url: x.url, w: x.width, h: x.height }]));
}

type Job = { key: string; page: string; bg: string | null; alt: string; jpg?: boolean };

/** Draw pages in one browser: the #pic box at 2×, fonts loaded first. */
export async function draw(jobs: Job[], log: (m: string) => void): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!jobs.length) return out;
  const { chromium } = await import("playwright-core");
  const path = [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p));
  const browser = await chromium.launch({
    ...(path ? { executablePath: path } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 2 });
    for (const j of jobs) {
      const page = await ctx.newPage();
      try {
        await page.setContent(j.page, { waitUntil: "load", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
        // Hero pages size their headlines after the fonts load (heroes.ts); wait for that.
        await page.waitForFunction(() => (window as unknown as { __heroReady?: boolean }).__heroReady !== false, null, { timeout: 10_000 }).catch(() => {});
        const el = await page.$("#pic");
        if (!el) continue;
        const png = await el.screenshot({ type: "png", omitBackground: !j.bg });
        out.set(j.key, png);
      } catch (e) {
        log(`[email-pics] ${j.key} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

/** Draw, shrink (palette PNG: headlines have few colours), store; returns the new pictures. */
async function make(pool: Pool, jobs: Job[], log: (m: string) => void): Promise<Record<string, Pic>> {
  const drawn = await draw(jobs.slice(0, MAX_PER_RUN), log);
  const made: Record<string, Pic> = {};
  for (const j of jobs) {
    const raw = drawn.get(j.key);
    if (!raw) continue;
    // Heroes are photos: JPG. Headlines have few colours: palette PNG.
    let bytes = j.jpg ? await sharp(raw).flatten({ background: "#0A0A0A" }).jpeg({ quality: 82, mozjpeg: true }).toBuffer() : await sharp(raw).png({ palette: true, quality: 95, effort: 8, compressionLevel: 9 }).toBuffer();
    if (!j.jpg && bytes.length > raw.length) bytes = raw;
    const ext = j.jpg ? "jpg" : "png";
    const m = await sharp(bytes).metadata();
    const w = Math.round((m.width ?? 2) / 2);
    const h = Math.round((m.height ?? 2) / 2);
    const url = `${WMS_BASE}/api/public/email-media/uploads/pic-${j.key}.${ext}`;
    await put({ path: `email/uploads/pic-${j.key}.${ext}`, bytes, contentType: j.jpg ? "image/jpeg" : "image/png" });
    await pool.query(
      `INSERT INTO email_text_pics (key, url, width, height, bytes, alt) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING`,
      [j.key, url, w, h, bytes.length, j.alt.slice(0, 1000)],
    );
    made[j.key] = { url, w, h };
  }
  return made;
}

/** Every picture this email needs, drawing the missing ones. */
export async function ensureDocPics(pool: Pool, doc: EmailDoc, log: (m: string) => void = console.log): Promise<Record<string, Pic>> {
  const all = picSources(doc);
  // Personal heroes (a name in the picture) are kept as pages and drawn per name on request.
  for (const p of all.filter((x) => x.personal))
    await pool
      .query(`INSERT INTO email_hero_pages (key, page, bg, alt) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`, [p.key, p.page, p.bg, p.alt.slice(0, 1000)])
      .catch((e) => log(`[email-pics] personal hero ${p.key}: ${e instanceof Error ? e.message : String(e)}`));
  const src = all.filter((x) => !x.personal);
  const have = await loadPics(pool, src.map((s) => s.key));
  const missing = src.filter((s) => !have[s.key]);
  if (!missing.length) return have;
  const made = await make(pool, missing.map((s) => ({ key: s.key, page: s.page, bg: s.bg, alt: s.alt, jpg: s.jpg })), log);
  log(`[email-pics] drew ${Object.keys(made).length} of ${missing.length} headline picture(s)`);
  return { ...have, ...made };
}

/** One run per email at a time (a second caller waits for the first). */
const running = new Map<string, Promise<void>>();

/**
 * Make sure an editor email's html has all its headline pictures: draw the missing ones, then put
 * them into the stored html — only if the email was not changed meanwhile (the next save does it).
 */
export function ensureEditorPics(
  pool: Pool,
  designId: string,
  render: (doc: EmailDoc, pics: Record<string, Pic>) => string,
  log: (m: string) => void = console.log,
  /** Re-render even without pictures (e.g. to put today's products in): the caller's render decides. */
  always = false,
): Promise<void> {
  const busy = running.get(designId);
  if (busy) return busy.then(() => ensureEditorPics(pool, designId, render, log, always));
  const run = (async () => {
    const d = await pool.query<{ editor_doc: unknown }>(`SELECT editor_doc FROM email_designs WHERE id = $1::uuid AND editor_doc IS NOT NULL`, [designId]);
    const doc = d.rows[0]?.editor_doc;
    if (!isDoc(doc) || (!always && !picSources(doc).length)) return;
    const pics = await ensureDocPics(pool, doc, log);
    const html = render(doc, pics);
    await pool.query(`UPDATE email_designs SET html = $2 WHERE id = $1::uuid AND editor_doc = $3::jsonb AND html IS DISTINCT FROM $2`, [designId, html, JSON.stringify(doc)]);
  })().finally(() => running.delete(designId));
  running.set(designId, run);
  return run;
}

/* ------------------------------------------------------------ translations */

/**
 * Spanish / Portuguese copies: the translated email still points at the English headline pictures.
 * Each one is drawn again from its translated words (same styles, width, colours) and swapped in.
 * translate(fragment) translates a block's HTML; a failed one keeps the English picture.
 */
export async function localizePics(
  pool: Pool,
  doc: EmailDoc,
  html: string,
  translate: (fragment: string) => Promise<string | null>,
  log: (m: string) => void = console.log,
): Promise<string> {
  // Heroes (JPG) keep their English words; headline pictures are drawn again translated.
  const src = picSources(doc).filter((s) => !s.jpg && html.includes(`pic-${s.key}.png`));
  if (!src.length) return html;
  const plan: { s: PicSource; job: Job }[] = [];
  for (const s of src) {
    const t = await translate(s.fragment).catch(() => null);
    if (!t) continue;
    const page = picPage(t, s.width, s.bg, doc.styles);
    plan.push({ s, job: { key: picKey(page), page, bg: s.bg, alt: plainText(t) } });
  }
  const have = await loadPics(pool, plan.map((p) => p.job.key));
  const made = await make(pool, plan.filter((p) => !have[p.job.key]).map((p) => p.job), log);
  const all = { ...have, ...made };
  let out = html;
  for (const { s, job } of plan) {
    const pic = all[job.key];
    if (!pic) continue;
    // Swap the picture and its alt text (the <img> written by render.ts picImg).
    const alt = job.alt.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
    out = out.replace(new RegExp(`<img\\b[^>]*pic-${s.key}\\.png[^>]*>`, "g"), (tag) =>
      tag.replace(/\ssrc="[^"]*"/, ` src="${pic.url}"`).replace(/\salt="[^"]*"/, ` alt="${alt}"`),
    );
  }
  return out;
}

/* ------------------------------------------------------- personal heroes (a name in the picture) */

const NAME_TAG = /\{\{\s*first_name\s*(?:\|([^}]*))?\}\}/g;
const drawing = new Map<string, Promise<string | null>>();
let drawsThisHour = { at: Date.now(), n: 0 };

/** A name as it may appear in a picture: letters, digits, spaces and . ' -; at most 24; capitals. */
export function cleanName(n: string | null): string {
  return (n ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} '.\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .toUpperCase();
}

/**
 * The picture of a personal hero for one name: stored once per (hero, name) and shared by everyone
 * with that name. Returns its public URL, or null when the hero does not exist (or too many new
 * names were asked for this hour: 3,000, so nobody can make the server draw without end).
 */
export async function personalHero(pool: Pool, key: string, rawName: string | null, log: (m: string) => void = console.log): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(key)) return null;
  const name = cleanName(rawName);
  const sub = hashKey(`${key}|${name}`);
  const have = await loadPics(pool, [sub]);
  if (have[sub]) return have[sub].url;
  const busy = drawing.get(sub);
  if (busy) return busy;
  if (Date.now() - drawsThisHour.at > 3_600_000) drawsThisHour = { at: Date.now(), n: 0 };
  if (++drawsThisHour.n > 3000) return null;
  const run = (async () => {
    const r = await pool.query<{ page: string; bg: string | null; alt: string }>(`SELECT page, bg, alt FROM email_hero_pages WHERE key = $1`, [key]);
    const row = r.rows[0];
    if (!row) return null;
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
    const page = row.page.replace(NAME_TAG, (_m, fb: string | undefined) => esc(name || cleanName(fb ?? "") || "MEMBER"));
    const alt = row.alt.replace(NAME_TAG, (_m, fb: string | undefined) => name || fb || "");
    const made = await make(pool, [{ key: sub, page, bg: row.bg, alt, jpg: true }], log);
    return made[sub]?.url ?? null;
  })().finally(() => drawing.delete(sub));
  drawing.set(sub, run);
  return run;
}
