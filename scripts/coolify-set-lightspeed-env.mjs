/**
 * Pushes Lightspeed + public-base URL env vars to the WMS Coolify app (bulk PATCH).
 *
 * Same auth requirements as `coolify-set-database-url.mjs`: token must be allowed to
 * **modify** application envs (deploy-only tokens return 403).
 *
 * Usage:
 *   1. Fill values in gitignored `.env.coolify.local` (or export):
 *        COOLIFY_BASE_URL, COOLIFY_API_TOKEN, COOLIFY_APP_UUID (or COOLIFY_DEPLOY_WEBHOOK_URL)
 *        NEXT_PUBLIC_BASE_URL and/or WMS_APP_PUBLIC_BASE_URL (carbon-gen uses the former; both are synced)
 *        LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN, LS_ACCOUNT_ID, LS_DOMAIN_PREFIX
 *        optional: LS_API_BASE, LS_OAUTH_TOKEN_URL, LS_MAX_CATALOG_PAGES, LS_PERSONAL_TOKEN, LS_REDIRECT_URI
 *   2. npm run coolify:set-lightspeed
 *   3. npm run deploy:coolify   (or Redeploy in Coolify UI)
 *
 * If LS_REDIRECT_URI is unset, it is derived from NEXT_PUBLIC_BASE_URL or WMS_APP_PUBLIC_BASE_URL
 * (same order as carbon-gen OAuth: NEXT_PUBLIC first).
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

const KEYS_OPTIONAL = [
  "LS_API_BASE",
  "LS_OAUTH_TOKEN_URL",
  "LS_MAX_CATALOG_PAGES",
  "LS_PERSONAL_TOKEN",
  "LS_REDIRECT_URI",
];

const KEYS_CORE = [
  "NEXT_PUBLIC_BASE_URL",
  "WMS_APP_PUBLIC_BASE_URL",
  "LS_CLIENT_ID",
  "LS_CLIENT_SECRET",
  "LS_REFRESH_TOKEN",
  "LS_ACCOUNT_ID",
  "LS_DOMAIN_PREFIX",
];

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
  console.error(
    "Missing COOLIFY_BASE_URL, COOLIFY_API_TOKEN, or COOLIFY_APP_UUID (or COOLIFY_DEPLOY_WEBHOOK_URL with uuid=).",
  );
  process.exit(1);
}

function trimEnv(name) {
  return String(process.env[name] ?? "").trim();
}

const bulk = [];
const pushedNames = [];

for (const key of KEYS_CORE) {
  const value = trimEnv(key);
  if (!value) continue;
  bulk.push({ key, value, is_literal: true, is_multiline: false });
  pushedNames.push(key);
}

for (const key of KEYS_OPTIONAL) {
  const value = trimEnv(key);
  if (!value) continue;
  bulk.push({ key, value, is_literal: true, is_multiline: false });
  pushedNames.push(key);
}

const nextPublic = trimEnv("NEXT_PUBLIC_BASE_URL").replace(/\/$/, "");
const wmsPublic = trimEnv("WMS_APP_PUBLIC_BASE_URL").replace(/\/$/, "");
/* Mirror carbon-gen: if only one public URL is set, push the other with the same value. */
if (nextPublic && !wmsPublic && !pushedNames.includes("WMS_APP_PUBLIC_BASE_URL")) {
  bulk.push({
    key: "WMS_APP_PUBLIC_BASE_URL",
    value: nextPublic,
    is_literal: true,
    is_multiline: false,
  });
  pushedNames.push("WMS_APP_PUBLIC_BASE_URL");
}
if (wmsPublic && !nextPublic && !pushedNames.includes("NEXT_PUBLIC_BASE_URL")) {
  bulk.push({
    key: "NEXT_PUBLIC_BASE_URL",
    value: wmsPublic,
    is_literal: true,
    is_multiline: false,
  });
  pushedNames.push("NEXT_PUBLIC_BASE_URL");
}

const publicBase = nextPublic || wmsPublic;
const explicitRedirect = trimEnv("LS_REDIRECT_URI");
if (publicBase && !explicitRedirect) {
  const derived = `${publicBase}/api/lightspeed/callback`;
  bulk.push({
    key: "LS_REDIRECT_URI",
    value: derived,
    is_literal: true,
    is_multiline: false,
  });
  if (!pushedNames.includes("LS_REDIRECT_URI")) pushedNames.push("LS_REDIRECT_URI");
}

const requiredForLive = ["LS_CLIENT_ID", "LS_CLIENT_SECRET", "LS_REFRESH_TOKEN", "LS_ACCOUNT_ID"];
const missing = requiredForLive.filter((k) => !trimEnv(k));
if (!nextPublic && !wmsPublic) {
  missing.push("NEXT_PUBLIC_BASE_URL or WMS_APP_PUBLIC_BASE_URL (OAuth / redirect base)");
}

if (bulk.length === 0) {
  console.error(
    "No Lightspeed-related env vars found to push. Set at least:\n" +
      "  NEXT_PUBLIC_BASE_URL or WMS_APP_PUBLIC_BASE_URL, LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN, LS_ACCOUNT_ID\n" +
      "in .env.coolify.local (or export them), then re-run.",
  );
  process.exit(1);
}

if (missing.length) {
  console.warn(
    "Warning: still missing (R-Series live catalog needs all of these):\n  - " +
      missing.join("\n  - "),
  );
}

const url = `${base}/applications/${appUuid}/envs/bulk`;
const res = await fetch(url, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ data: bulk }),
});

const text = await res.text();
console.log(res.status, text.slice(0, 800));
if (!res.ok) {
  if (res.status === 403) {
    console.error(
      "\n403: Coolify token cannot update env vars. Create an API token with permission to modify application environment (not deploy-only).",
    );
  }
  process.exit(1);
}

console.log("\nPatched keys (values not shown):", pushedNames.join(", "));
console.log("Next: npm run deploy:coolify — or Redeploy in Coolify — so the container loads new env.");
console.log(
  "Lightspeed dev app: add redirect URL = " +
    (explicitRedirect || (publicBase ? `${publicBase}/api/lightspeed/callback` : "(set NEXT_PUBLIC_BASE_URL or WMS_APP_PUBLIC_BASE_URL)")),
);
