#!/usr/bin/env node
/**
 * Upload a release APK to WMS (admin session). OTA users get it via active release.
 *
 * Env:
 *   WMS_APP_PUBLIC_BASE_URL or NEXT_PUBLIC_BASE_URL — e.g. https://wms.example.com
 *   WMS_UPLOAD_SESSION_COOKIE — full Cookie header value including wms_session=...
 *
 * Usage:
 *   node scripts/upload-mobile-apk.mjs <path-to.apk> [versionLabel]
 *
 * Or: APK_PATH and APK_VERSION_LABEL in env.
 */
import fs from "node:fs";
import path from "node:path";

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
