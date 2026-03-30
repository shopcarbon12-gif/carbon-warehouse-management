/**
 * PATCH Coolify application env vars (bulk). Token must allow env updates (not deploy-only).
 *
 * Usage:
 *   node scripts/coolify-patch-env-bulk.mjs KEY=value KEY2=value2
 * Example:
 *   node scripts/coolify-patch-env-bulk.mjs WMS_AUTO_MIGRATE=1
 *
 * Loads .env.coolify.local for COOLIFY_* (same as other scripts).
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

const base = (process.env.COOLIFY_BASE_URL || defaultApiBase()).replace(/\/$/, "");
const token = process.env.COOLIFY_API_TOKEN?.trim();
const appUuid =
  process.env.COOLIFY_APP_UUID?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!base || !token || !appUuid || args.length === 0) {
  console.error(
    "Usage: node scripts/coolify-patch-env-bulk.mjs KEY=value [KEY2=value2 ...]\n" +
      "Requires COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_API_TOKEN (in .env.coolify.local).",
  );
  process.exit(1);
}

const bulk = [];
for (const pair of args) {
  const i = pair.indexOf("=");
  if (i <= 0) {
    console.error("Bad pair (expected KEY=value):", pair);
    process.exit(1);
  }
  const key = pair.slice(0, i).trim();
  const value = pair.slice(i + 1);
  bulk.push({
    key,
    value,
    is_literal: true,
    is_multiline: false,
  });
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
if (!res.ok) process.exit(1);
console.log("\nOK. Redeploy the WMS app so the container picks up new env.");
