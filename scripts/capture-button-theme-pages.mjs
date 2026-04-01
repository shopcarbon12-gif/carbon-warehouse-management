#!/usr/bin/env node
/**
 * Screenshots only for routes touched in the “button visibility / theme” pass
 * (pics 1,2,3,6) and commissioning status (teal idle).
 *
 *   node scripts/capture-button-theme-pages.mjs
 *
 * Optional:
 *   PLAYWRIGHT_CHANNEL=chrome  — use installed Google Chrome (Windows: chrome.exe)
 *   PLAYWRIGHT_HEADED=1        — headed window (default headless)
 *
 * Env: same as capture-theme-evidence.mjs (WMS_SCREENSHOT_* or SEED_ADMIN_PASSWORD, PLAYWRIGHT_BASE_URL).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseURL = (process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3040").replace(/\/+$/, "");
const outDir = path.join(process.cwd(), "docs", "light-theme-evidence", "changed-pages-button-theme");
fs.mkdirSync(outDir, { recursive: true });

function loadEnvFile(file) {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const email =
  process.env.WMS_SCREENSHOT_EMAIL?.trim() ||
  process.env.SEED_ADMIN_EMAIL?.trim() ||
  "admin@example.com";
const password =
  process.env.WMS_SCREENSHOT_PASSWORD?.trim() ||
  process.env.SEED_ADMIN_PASSWORD?.trim();

const ROUTES = [
  "/",
  "/settings/handheld",
  "/infrastructure/devices",
  "/infrastructure/lightspeed-sales",
  "/infrastructure/settings",
  "/inventory/sync",
  "/inventory/bulk-status",
  "/inventory/catalog",
  "/rfid/commissioning",
];

function slug(route) {
  return route.replace(/^\//, "").replace(/\//g, "__") || "root";
}

async function tryLogin(page) {
  if (!password) {
    console.warn("No WMS_SCREENSHOT_PASSWORD / SEED_ADMIN_PASSWORD — login will fail.");
    return false;
  }
  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }).catch(() => null);
  if (page.url().includes("/login")) {
    console.error("Login failed.");
    return false;
  }
  console.log("Logged in OK.");
  return true;
}

const channel =
  process.env.PLAYWRIGHT_CHANNEL?.trim().toLowerCase() === "chrome" ? "chrome" : undefined;
const headless = process.env.PLAYWRIGHT_HEADED === "1" || process.env.PLAYWRIGHT_HEADED === "true" ? false : true;
const browser = await chromium.launch({
  channel,
  headless,
});
if (channel) console.log("Browser: Google Chrome (channel)");
else console.log("Browser: Playwright Chromium bundle");
console.log(headless ? "Mode: headless" : "Mode: headed");
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

await context.addInitScript(() => {
  try {
    localStorage.setItem("wms_theme_color", "light");
    localStorage.setItem("wms_theme_font", "expanded");
  } catch {
    /* ignore */
  }
});

const page = await context.newPage();
const ok = await tryLogin(page);
if (!ok) {
  await browser.close();
  process.exit(1);
}

const settleMs = Number(process.env.WMS_SCREENSHOT_SETTLE_MS || 4200);

for (const route of ROUTES) {
  const name = `${slug(route)}.png`;
  try {
    await page.goto(`${baseURL}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    /* SWR + location switcher need time; handheld page shows “Loading…” briefly. */
    if (route === "/settings/handheld") {
      await page
        .getByRole("button", { name: "Save handheld settings" })
        .waitFor({ state: "visible", timeout: 45_000 })
        .catch(() => null);
    }
    await page.waitForTimeout(settleMs);
    await page.screenshot({ path: path.join(outDir, name), fullPage: true });
    console.log("saved", name);
  } catch (e) {
    console.error("skip", route, String(e?.message || e));
  }
}

await browser.close();
console.log("done →", outDir);
