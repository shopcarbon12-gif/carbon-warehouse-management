#!/usr/bin/env node
/**
 * Upload a release APK to WMS (admin session). OTA users get it via active release.
 *
 * Env:
 *   WMS_APP_PUBLIC_BASE_URL or NEXT_PUBLIC_BASE_URL — e.g. https://wms.example.com
 *   WMS_UPLOAD_SESSION_COOKIE — full Cookie header value including wms_session=...
 *   Optional: put the same keys in gitignored `.env.coolify.local` so you do not export them in the shell.
 *
 * Usage:
 *   node scripts/upload-mobile-apk.mjs <path-to.apk> [versionLabel]
 *
 * Or: APK_PATH and APK_VERSION_LABEL in env.
 */
import fs from "node:fs";
import path from "node:path";

/** Fill missing keys from gitignored `.env.coolify.local` (no dependency on dotenv). */
function loadCoolifyLocal() {
  const p = path.join(process.cwd(), ".env.coolify.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  const keys = new Set([
    "WMS_UPLOAD_SESSION_COOKIE",
    "WMS_APP_PUBLIC_BASE_URL",
    "NEXT_PUBLIC_BASE_URL",
  ]);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!keys.has(key) || process.env[key] !== undefined) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadCoolifyLocal();

const baseRaw =
  process.env.WMS_APP_PUBLIC_BASE_URL?.trim() ||
  process.env.NEXT_PUBLIC_BASE_URL?.trim();
const cookie = process.env.WMS_UPLOAD_SESSION_COOKIE?.trim();
const apkPath = process.argv[2]?.trim() || process.env.APK_PATH?.trim();
const versionLabel =
  process.argv[3]?.trim() ||
  process.env.APK_VERSION_LABEL?.trim() ||
  "manual-upload";

if (!baseRaw || !cookie || !apkPath) {
  console.error(
    "Missing env or args. Need WMS_APP_PUBLIC_BASE_URL (or NEXT_PUBLIC_BASE_URL), WMS_UPLOAD_SESSION_COOKIE, and APK path.\n" +
      "Example: WMS_UPLOAD_SESSION_COOKIE='wms_session=...' node scripts/upload-mobile-apk.mjs ./app-release.apk 0.1.10+14",
  );
  process.exit(1);
}

if (!fs.existsSync(apkPath)) {
  console.error("APK not found:", apkPath);
  process.exit(1);
}

const base = baseRaw.replace(/\/+$/, "");
const url = `${base}/api/mobile/upload-apk`;

const buf = fs.readFileSync(apkPath);
const blob = new Blob([buf]);
const fd = new FormData();
fd.set("versionLabel", versionLabel);
fd.set("apk", blob, path.basename(apkPath));

const res = await fetch(url, {
  method: "POST",
  headers: { Cookie: cookie },
  body: fd,
});

const text = await res.text();
console.log(res.status, text);
process.exit(res.ok ? 0 : 1);
