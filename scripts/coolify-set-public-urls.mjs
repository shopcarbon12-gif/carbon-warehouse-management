/**
 * PATCH Coolify WMS app: NEXT_PUBLIC_BASE_URL + WMS_APP_PUBLIC_BASE_URL (production).
 * Requires write-capable COOLIFY_API_TOKEN + COOLIFY_APP_UUID (or uuid in webhook URL).
 * Loads `.env.coolify.local` like other Coolify scripts.
 *
 *   npm run coolify:set-public-urls
 *
 * Override target origin:
 *   WMS_PRODUCTION_PUBLIC_URL=https://wms.shopcarbon.com npm run coolify:set-public-urls
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");

function loadLocal() {
  if (!fs.existsSync(dotenvPath)) return;
  let text = fs.readFileSync(dotenvPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (process.env[key]) continue;
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadLocal();

function defaultApiBase() {
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  if (!u) return "";
  try {
    const { protocol, host } = new URL(u);
    return `${protocol}//${host}/api/v1`;
  } catch {
    return "";
  }
}

const prodUrl = (process.env.WMS_PRODUCTION_PUBLIC_URL || "https://wms.shopcarbon.com").replace(
  /\/+$/,
  "",
);
const base = (process.env.COOLIFY_BASE_URL || defaultApiBase()).replace(/\/$/, "");
const token = process.env.COOLIFY_API_TOKEN?.trim();
const appUuid =
  process.env.COOLIFY_APP_UUID?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();

if (!base || !token || !appUuid) {
  console.log(
    "coolify:set-public-urls — skipped (need COOLIFY_API_TOKEN + COOLIFY_APP_UUID or webhook URL with uuid in .env.coolify.local).",
  );
  console.log("Manually in Coolify → WMS → Environment:");
  console.log("  NEXT_PUBLIC_BASE_URL=" + prodUrl);
  console.log("  WMS_APP_PUBLIC_BASE_URL=" + prodUrl);
  process.exit(0);
}

const url = `${base}/applications/${appUuid}/envs/bulk`;
const res = await fetch(url, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    data: [
      { key: "NEXT_PUBLIC_BASE_URL", value: prodUrl, is_literal: true, is_multiline: false },
      { key: "WMS_APP_PUBLIC_BASE_URL", value: prodUrl, is_literal: true, is_multiline: false },
    ],
  }),
});

const text = await res.text();
console.log(res.status, text.slice(0, 600));
if (!res.ok) process.exit(1);
console.log("\nOK. Redeploy WMS so the container picks up NEXT_PUBLIC_* build/runtime vars.");
