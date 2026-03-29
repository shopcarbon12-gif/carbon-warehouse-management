/**
 * Fetches a PostgreSQL resource's internal URL from Coolify API and PATCHes DATABASE_URL
 * on the WMS application (same bulk env as coolify-set-database-url.mjs).
 *
 * Requires in .env.coolify.local (or env):
 *   COOLIFY_BASE_URL / COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_API_TOKEN, COOLIFY_APP_UUID (or webhook uuid=)
 * Optional:
 *   COOLIFY_POSTGRES_UUID   — exact Postgres database UUID in Coolify (recommended)
 *   COOLIFY_POSTGRES_NAME_SUBSTR — case-insensitive substring to match DB name if uuid not set
 *   COOLIFY_WMS_BOOTSTRAP=1 — also set WMS_AUTO_MIGRATE / WMS_AUTO_SEED
 *
 * @see https://coolify.io/docs/api-reference/api/operations/list-databases
 * @see https://coolify.io/docs/api-reference/api/operations/get-database-by-uuid
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

const explicitPg = process.env.COOLIFY_POSTGRES_UUID?.trim();
const nameSub = process.env.COOLIFY_POSTGRES_NAME_SUBSTR?.trim().toLowerCase();

if (!base || !token || !appUuid) {
  console.error("Missing COOLIFY_BASE_URL (or webhook URL), COOLIFY_API_TOKEN, or app uuid.");
  process.exit(1);
}

async function apiGet(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { res, data };
}

function pickInternalUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  const keys = [
    "internal_db_url",
    "internal_url",
    "postgres_url",
    "database_url",
    "connection_string",
  ];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== "string" || v.length < 12) continue;
    if (v.startsWith("postgresql://") || v.startsWith("postgres://")) {
      return v.startsWith("postgres://") ? `postgresql://${v.slice("postgres://".length)}` : v;
    }
  }
  return "";
}

let pgUuid = explicitPg;
let internalUrl = "";

if (pgUuid) {
  const { res, data } = await apiGet(`/databases/${pgUuid}`);
  if (!res.ok) {
    console.error(res.status, "GET /databases/{uuid} failed:", typeof data === "string" ? data.slice(0, 400) : data);
    process.exit(1);
  }
  internalUrl = pickInternalUrl(data);
  if (!internalUrl && typeof data === "object" && data) {
    internalUrl = pickInternalUrl(data.database ?? data);
  }
} else {
  const { res: appRes, data: appData } = await apiGet(`/applications/${appUuid}`);
  if (!appRes.ok) {
    console.error(appRes.status, "GET application failed");
    process.exit(1);
  }
  const appEnvId = appData?.environment_id;

  const { res, data } = await apiGet("/databases");
  if (!res.ok) {
    console.error(res.status, "GET /databases failed:", typeof data === "string" ? data.slice(0, 400) : data);
    process.exit(1);
  }
  const list = Array.isArray(data) ? data : data?.data ?? data?.databases ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    console.error("No databases returned. Set COOLIFY_POSTGRES_UUID in .env.coolify.local.");
    process.exit(1);
  }
  let pg = list.filter((d) => {
    const t = (d.type ?? d.database_type ?? d.kind ?? "").toString().toLowerCase();
    const isPg = t.includes("postgres") || t === "postgresql";
    if (!isPg) return false;
    if (!nameSub) return true;
    const n = (d.name ?? d.uuid ?? "").toString().toLowerCase();
    return n.includes(nameSub);
  });
  if (pg.length > 1 && appEnvId != null) {
    const scoped = pg.filter((d) => d.environment_id === appEnvId);
    if (scoped.length === 1) {
      console.log(`Using Postgres in same environment as WMS (environment_id=${appEnvId}).`);
      pg = scoped;
    }
  }
  if (pg.length === 0) {
    console.error(
      "No matching PostgreSQL database. Set COOLIFY_POSTGRES_UUID or COOLIFY_POSTGRES_NAME_SUBSTR.",
    );
    process.exit(1);
  }
  if (pg.length > 1) {
    console.error(
      "Multiple PostgreSQL databases match. Set COOLIFY_POSTGRES_UUID to one of:",
      pg.map((p) => `${p.name ?? "?"} (${p.uuid})`).join(", "),
    );
    process.exit(1);
  }
  pgUuid = pg[0].uuid;
  if (!pgUuid) {
    console.error("List entry missing uuid:", JSON.stringify(pg[0]).slice(0, 200));
    process.exit(1);
  }
  const detail = await apiGet(`/databases/${pgUuid}`);
  if (!detail.res.ok) {
    console.error(detail.res.status, "GET detail failed");
    process.exit(1);
  }
  const d = detail.data;
  internalUrl = pickInternalUrl(d);
  if (!internalUrl && typeof d === "object" && d) {
    internalUrl = pickInternalUrl(d.database ?? d);
  }
}

if (!internalUrl || !internalUrl.startsWith("postgresql")) {
  console.error(
    "Could not read internal postgres URL from API response. Set COOLIFY_DATABASE_URL manually or update this script for your Coolify version.",
  );
  process.exit(1);
}

const bulk = [
  {
    key: "DATABASE_URL",
    value: internalUrl,
    is_literal: true,
    is_multiline: false,
  },
];
if (process.env.COOLIFY_WMS_BOOTSTRAP === "1") {
  bulk.push(
    {
      key: "WMS_AUTO_MIGRATE",
      value: "1",
      is_literal: true,
      is_multiline: false,
    },
    {
      key: "WMS_AUTO_SEED",
      value: "1",
      is_literal: true,
      is_multiline: false,
    },
  );
  console.log("COOLIFY_WMS_BOOTSTRAP=1: patching WMS_AUTO_MIGRATE, WMS_AUTO_SEED");
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
console.log("PATCH app envs:", res.status, text.slice(0, 120).replace(/postgresql:[^"]+/g, "postgresql://[redacted]"));
if (!res.ok) process.exit(1);
console.log(`Synced DATABASE_URL from Postgres Coolify uuid ${pgUuid}. Run npm run deploy:coolify.`);
