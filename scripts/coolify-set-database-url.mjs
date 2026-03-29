/**
 * Sets DATABASE_URL on a Coolify application via API (bulk env PATCH).
 *
 * Requires an API token with **read** + **write** (or root) on applications — a
 * deploy-only token returns 403 on GET and usually cannot PATCH envs.
 *
 * Usage:
 *   1. Put in .env.coolify.local (or export):
 *        COOLIFY_BASE_URL=http://YOUR_HOST:8000/api/v1
 *        COOLIFY_API_TOKEN=...   # token with write env permission
 *        COOLIFY_APP_UUID=...     # WMS application UUID (from Webhooks URL)
 *        COOLIFY_DATABASE_URL=postgresql://user:pass@internal-host:5432/dbname
 *   2. node scripts/coolify-set-database-url.mjs
 *   3. Redeploy the app in Coolify (or npm run deploy:coolify).
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
const databaseUrl = process.env.COOLIFY_DATABASE_URL?.trim();

if (!base || !token || !appUuid) {
  console.error(
    "Missing COOLIFY_BASE_URL, COOLIFY_API_TOKEN, or COOLIFY_APP_UUID (or COOLIFY_DEPLOY_WEBHOOK_URL with uuid=).",
  );
  process.exit(1);
}
if (!databaseUrl) {
  console.error(
    "Set COOLIFY_DATABASE_URL to the Postgres URL the **container** must use:\n" +
      "  e.g. postgresql://postgres:PASSWORD@postgresql-database-xxxxx:5432/postgres\n" +
      "Copy from Coolify → PostgreSQL resource → General → Postgres URL (internal).",
  );
  process.exit(1);
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
      {
        key: "DATABASE_URL",
        value: databaseUrl,
        is_literal: true,
        is_multiline: false,
      },
    ],
  }),
});

const text = await res.text();
console.log(res.status, text.slice(0, 500));
if (!res.ok) process.exit(1);
console.log("\nDone. Redeploy the WMS app in Coolify so the container picks up DATABASE_URL.");
