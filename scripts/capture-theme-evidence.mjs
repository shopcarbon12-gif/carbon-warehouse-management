#!/usr/bin/env node
/**
 * Full-page screenshots for light-theme evidence (before / after).
 * Requires: dev server on 3040, DB + optional credentials.
 *
 *   node scripts/capture-theme-evidence.mjs before
 *   node scripts/capture-theme-evidence.mjs after
 *
 * Env:
 *   WMS_SCREENSHOT_EMAIL / WMS_SCREENSHOT_PASSWORD — required for authenticated routes
 *   PLAYWRIGHT_BASE_URL — default http://127.0.0.1:3040
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const phase = (process.argv[2] || "before").toLowerCase();
if (phase !== "before" && phase !== "after") {
  console.error("Usage: node scripts/capture-theme-evidence.mjs before|after");
  process.exit(1);
}

const baseURL = (process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3040").replace(/\/+$/, "");
const outDir = path.join(process.cwd(), "docs", "light-theme-evidence", phase);
fs.mkdirSync(outDir, { recursive: true });

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
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

loadEnvLocal();

const email =
  process.env.WMS_SCREENSHOT_EMAIL?.trim() ||
  process.env.SEED_ADMIN_EMAIL?.trim() ||
  "admin@example.com";
const password =
  process.env.WMS_SCREENSHOT_PASSWORD?.trim() ||
  process.env.SEED_ADMIN_PASSWORD?.trim();

/** @type {string[]} */
const ROUTES = [
  "/login",
  "/dashboard",
  "/inventory",
  "/inventory/catalog",
  "/inventory/bulk-status",
  "/inventory/sync",
  "/inventory/transfers/in",
  "/inventory/transfers/out",
  "/overview/locations",
  "/locations",
  "/handheld",
  "/compare",
  "/orders",
  "/alerts",
  "/integrations",
  "/sync",
  "/rfid",
  "/rfid/epc-tracker",
  "/rfid/commissioning",
  "/rfid/cycle-counts",
  "/operations/exceptions",
  "/operations/transfers",
  "/infrastructure/devices",
  "/infrastructure/settings",
  "/infrastructure/lightspeed-sales",
  "/reports/inventory-compare",
  "/reports/uploads",
  "/reports/activity",
  "/reports/asset-movements",
  "/reports/status-logs",
  "/reports/adjustments",
  "/reports/replenishments",
  "/reports/bulk-imports",
  "/reports/external-systems",
  "/settings",
  "/settings/theme",
  "/settings/handheld",
  "/settings/updates",
  "/settings/devices",
  "/settings/statuses",
  "/settings/general",
  "/settings/epc-profiles",
  "/settings/users",
  "/settings/locations",
  /* Dev API doc (optional): "/docs/handheld-api" — not main WMS UI; omit from theme evidence */
];

function slug(route) {
  if (route === "/") return "root";
  return route.replace(/^\//, "").replace(/\//g, "__") || "root";
}

async function tryLogin(page) {
  if (!email || !password) {
    console.warn("WMS_SCREENSHOT_EMAIL/PASSWORD unset — only public routes will look correct.");
    return false;
  }
  await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }).catch(() => null);
  const stillLogin = page.url().includes("/login");
  if (stillLogin) {
    console.error("Login failed — check WMS_SCREENSHOT_EMAIL / WMS_SCREENSHOT_PASSWORD and DATABASE_URL.");
    return false;
  }
  console.log("Logged in OK.");
  return true;
}

const browser = await chromium.launch({ headless: true });
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

const okLogin = await tryLogin(page);

for (const route of ROUTES) {
  const name = `${slug(route)}.png`;
  const target = `${baseURL}${route}`;
  try {
    if (!okLogin && route !== "/login") {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } else {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(outDir, name), fullPage: true });
    console.log("saved", phase, name);
  } catch (e) {
    console.error("skip", route, String(e?.message || e));
  }
}

await browser.close();
console.log("done", phase, "→", outDir);
