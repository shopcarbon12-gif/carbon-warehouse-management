/**
 * Fetches Postgres connection URL from Coolify API and updates DATABASE_URL in .env.coolify.local.
 *
 * - Prefers a **public** URL if the API exposes host + port mapping (laptop / npm run db:copy-bins).
 * - Otherwise writes the **internal** Docker URL (only works from inside the VPS network — use SSH tunnel or Coolify "Public port").
 *
 * Uses same discovery as coolify-sync-postgres-url.mjs (COOLIFY_API_TOKEN, webhook → base + app uuid).
 *
 * Usage: node scripts/coolify-fetch-database-url-to-local.mjs
 * Options: --dry-run (print which URL would be written, redacted)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");

function loadLocal() {
  if (!fs.existsSync(dotenvPath)) {
    console.error("Missing .env.coolify.local");
    process.exit(1);
  }
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
const dryRun = process.argv.includes("--dry-run");

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

/** Try to build a URL reachable from outside Docker (laptop). */
function pickPublicPostgresUrl(d) {
  if (!d || typeof d !== "object") return "";
  const rootObj = d.database && typeof d.database === "object" ? d.database : d;

  const pubHost =
    process.env.COOLIFY_POSTGRES_PUBLIC_HOST?.trim() ||
    rootObj.public_host ||
    rootObj.server_ip ||
    rootObj.ip ||
    "";

  const ports =
    rootObj.ports_mappings ||
    rootObj.ports_strippings ||
    rootObj.custom_labels ||
    rootObj.ports ||
    null;

  let hostPort = null;
  if (typeof ports === "string") {
    const m = ports.match(/(\d+):5432/);
    if (m) hostPort = m[1];
  } else if (Array.isArray(ports)) {
    for (const p of ports) {
      if (typeof p === "string") {
        const m = p.match(/(\d+):5432/);
        if (m) {
          hostPort = m[1];
          break;
        }
      }
      if (p && typeof p === "object") {
        const c = p.published_port ?? p.host_port ?? p.public_port;
        const t = p.target_port ?? p.container_port;
        if (c && (t === 5432 || String(t) === "5432")) {
          hostPort = String(c);
          break;
        }
      }
    }
  }

  let internal = pickInternalUrl(rootObj);
  if (!internal) internal = pickInternalUrl(d);
  if (!internal || !pubHost || !hostPort) return "";

  try {
    const u = new URL(internal.replace(/^postgresql:/i, "http:"));
    const user = decodeURIComponent(u.username || "postgres");
    const pass = decodeURIComponent(u.password || "");
    const db = (u.pathname || "/postgres").replace(/^\//, "") || "postgres";
    const encUser = encodeURIComponent(user);
    const encPass = encodeURIComponent(pass);
    const auth = pass ? `${encUser}:${encPass}` : encUser;
    return `postgresql://${auth}@${pubHost}:${hostPort}/${db}`;
  } catch {
    return "";
  }
}

let pgUuid = explicitPg;
let detailData = null;

if (pgUuid) {
  const { res, data } = await apiGet(`/databases/${pgUuid}`);
  if (!res.ok) {
    console.error(res.status, "GET /databases/{uuid} failed");
    process.exit(1);
  }
  detailData = data;
} else {
  const { res: appRes, data: appData } = await apiGet(`/applications/${appUuid}`);
  if (!appRes.ok) {
    console.error(appRes.status, "GET application failed");
    process.exit(1);
  }
  const appEnvId = appData?.environment_id;

  const { res, data } = await apiGet("/databases");
  if (!res.ok) {
    console.error(res.status, "GET /databases failed");
    process.exit(1);
  }
  const list = Array.isArray(data) ? data : data?.data ?? data?.databases ?? [];
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
    if (scoped.length === 1) pg = scoped;
  }
  if (pg.length !== 1) {
    console.error(
      "Set COOLIFY_POSTGRES_UUID or COOLIFY_POSTGRES_NAME_SUBSTR. Matching DBs:",
      pg.map((p) => `${p.name} (${p.uuid})`).join(", ") || "(none)",
    );
    process.exit(1);
  }
  pgUuid = pg[0].uuid;
  const detail = await apiGet(`/databases/${pgUuid}`);
  if (!detail.res.ok) {
    console.error(detail.res.status, "GET detail failed");
    process.exit(1);
  }
  detailData = detail.data;
}

const rootObj = detailData?.database && typeof detailData.database === "object" ? detailData.database : detailData;
const internalUrl = pickInternalUrl(detailData) || pickInternalUrl(rootObj);

function publicUrlFromEnvFallback(internal) {
  if (!internal || typeof internal !== "string") return "";
  const port = process.env.COOLIFY_POSTGRES_PUBLIC_PORT?.trim();
  if (!port) return "";
  let host = process.env.COOLIFY_POSTGRES_PUBLIC_HOST?.trim();
  if (!host) {
    try {
      host = new URL(process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "").hostname;
    } catch {
      return "";
    }
  }
  if (!host) return "";
  try {
    const u = new URL(internal.replace(/^postgresql:/i, "http:"));
    const user = decodeURIComponent(u.username || "postgres");
    const pass = decodeURIComponent(u.password || "");
    const db = (u.pathname || "/postgres").replace(/^\//, "") || "postgres";
    const auth = pass
      ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`
      : encodeURIComponent(user);
    return `postgresql://${auth}@${host}:${port}/${db}`;
  } catch {
    return "";
  }
}

let publicUrl = pickPublicPostgresUrl(detailData);
if (!publicUrl) publicUrl = publicUrlFromEnvFallback(internalUrl);

const chosen = publicUrl || internalUrl;
if (!chosen || !chosen.startsWith("postgresql")) {
  console.error("Could not derive postgres URL from API. Set DATABASE_URL manually in .env.coolify.local.");
  process.exit(1);
}

if (dryRun) {
  const redact = (u) => u.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://***:***@");
  console.log("Would set DATABASE_URL to:", redact(chosen));
  console.log(publicUrl ? "(public form)" : "(internal Docker — not reachable from laptop without tunnel)");
  process.exit(0);
}

let file = fs.readFileSync(dotenvPath, "utf8");
if (file.charCodeAt(0) === 0xfeff) file = file.slice(1);

const newLine = `DATABASE_URL=${chosen}`;
if (/^DATABASE_URL=/m.test(file)) {
  file = file.replace(/^DATABASE_URL=.*$/m, newLine);
} else {
  file = `${file.trimEnd()}\n${newLine}\n`;
}

fs.writeFileSync(dotenvPath, file, "utf8");
console.log(
  publicUrl
    ? "Updated .env.coolify.local DATABASE_URL (public / mapped port — OK for db:copy-bins from this PC)."
    : "Updated .env.coolify.local DATABASE_URL (internal Docker host). From your PC use SSH tunnel or set COOLIFY_POSTGRES_PUBLIC_HOST + mapped port; see file comments.",
);
console.log(`Postgres resource uuid: ${pgUuid}`);
