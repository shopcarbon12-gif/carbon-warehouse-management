/**
 * Patch carbon-wms-sync-worker DATABASE_URL to a form reachable from the worker container
 * when internal Docker DNS (postgresql-database-…) still fails after connect_to_docker_network.
 *
 * Builds a **public** URL: host from COOLIFY_POSTGRES_PUBLIC_HOST or the Coolify server
 * hostname (from COOLIFY_DEPLOY_WEBHOOK_URL), port from API ports_mappings or
 * COOLIFY_POSTGRES_PUBLIC_PORT (default 3000 when using host fallback — matches many VPS maps).
 *
 * Loads .env.coolify.local: COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID,
 * optional COOLIFY_POSTGRES_UUID, COOLIFY_POSTGRES_PUBLIC_HOST, COOLIFY_POSTGRES_PUBLIC_PORT.
 *
 * Usage:
 *   node scripts/coolify-worker-public-database-url.mjs
 *   node scripts/coolify-worker-public-database-url.mjs --dry-run
 *   node scripts/coolify-worker-public-database-url.mjs --no-deploy
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";

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

const dryRun = process.argv.includes("--dry-run");
const noDeploy = process.argv.includes("--no-deploy");

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
const webUuid =
  process.env.COOLIFY_APP_UUID?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();
const workerUuid = process.env.COOLIFY_WORKER_APP_UUID?.trim();
const explicitPg = process.env.COOLIFY_POSTGRES_UUID?.trim();
const nameSub = process.env.COOLIFY_POSTGRES_NAME_SUBSTR?.trim().toLowerCase();

if (!base || !token || !webUuid || !workerUuid) {
  console.error(
    "Need COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID (and web uuid from webhook).",
  );
  process.exit(1);
}

const h = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function apiGet(path) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

function pickInternalUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  const keys = ["internal_db_url", "internal_url", "postgres_url", "database_url", "connection_string"];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== "string" || v.length < 12) continue;
    if (v.startsWith("postgresql://") || v.startsWith("postgres://")) {
      return v.startsWith("postgres://") ? `postgresql://${v.slice("postgres://".length)}` : v;
    }
  }
  return "";
}

function pickPublicPostgresUrl(d) {
  if (!d || typeof d !== "object") return "";
  const rootObj = d.database && typeof d.database === "object" ? d.database : d;

  const pubHost =
    process.env.COOLIFY_POSTGRES_PUBLIC_HOST?.trim() ||
    rootObj.public_host ||
    rootObj.server_ip ||
    rootObj.ip ||
    "";

  const ports = rootObj.ports_mappings || rootObj.ports_strippings || rootObj.ports || null;

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

function unquoteEnvVal(v) {
  if (v == null || typeof v !== "string") return "";
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Preserve user, password, database name, and query string; only swap host + port. */
function rewritePostgresHostPort(internalUrl, newHost, newPort) {
  if (!internalUrl || !newHost || !newPort) return "";
  try {
    const u = new URL(internalUrl.replace(/^postgresql:/i, "http:"));
    const user = safeDecode(u.username || "postgres");
    const pass = safeDecode(u.password || "");
    const db = (u.pathname || "/postgres").replace(/^\//, "") || "postgres";
    const search = u.search || "";
    const encUser = encodeURIComponent(user);
    const encPass = encodeURIComponent(pass);
    const auth = pass ? `${encUser}:${encPass}` : encUser;
    return `postgresql://${auth}@${newHost}:${newPort}/${db}${search}`;
  } catch {
    return "";
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function extractPublicHostPort(detailData, hintInternalUrl) {
  const fromPick = pickPublicPostgresUrl(detailData);
  if (fromPick) {
    try {
      const u = new URL(fromPick.replace(/^postgresql:/i, "http:"));
      return { host: u.hostname, port: u.port || "5432" };
    } catch {
      /* fall through */
    }
  }
  const port =
    process.env.COOLIFY_POSTGRES_PUBLIC_PORT?.trim() ||
    (hintInternalUrl && hintInternalUrl.includes("postgresql-database-") ? "3000" : "");
  let host = process.env.COOLIFY_POSTGRES_PUBLIC_HOST?.trim();
  if (!host) {
    try {
      host = new URL(process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "").hostname;
    } catch {
      return null;
    }
  }
  if (!host || !port) return null;
  return { host, port };
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
  const { res: appRes, data: appData } = await apiGet(`/applications/${webUuid}`);
  if (!appRes.ok) {
    console.error(appRes.status, "GET web application failed");
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
      "Set COOLIFY_POSTGRES_UUID or COOLIFY_POSTGRES_NAME_SUBSTR. Matches:",
      pg.map((p) => `${p.name} (${p.uuid})`).join(", ") || "(none)",
    );
    process.exit(1);
  }
  pgUuid = pg[0].uuid;
  const detail = await apiGet(`/databases/${pgUuid}`);
  if (!detail.res.ok) {
    console.error(detail.res.status, "GET database detail failed");
    process.exit(1);
  }
  detailData = detail.data;
}

const rootObj = detailData?.database && typeof detailData.database === "object" ? detailData.database : detailData;
const internalUrl = pickInternalUrl(detailData) || pickInternalUrl(rootObj);

const { res: webEnvRes, data: webEnvRows } = await apiGet(`/applications/${webUuid}/envs`);
if (!webEnvRes.ok) {
  console.error("GET web application envs failed:", webEnvRes.status);
  process.exit(1);
}
const rows = Array.isArray(webEnvRows) ? webEnvRows : [];
const dbRow = rows.find((r) => r.key === "DATABASE_URL");
const webDatabaseUrl = unquoteEnvVal(dbRow?.real_value ?? dbRow?.value ?? "");

const sourceUrl =
  webDatabaseUrl && (webDatabaseUrl.startsWith("postgresql://") || webDatabaseUrl.startsWith("postgres://"))
    ? webDatabaseUrl.startsWith("postgres://")
      ? `postgresql://${webDatabaseUrl.slice("postgres://".length)}`
      : webDatabaseUrl
    : internalUrl;

if (!sourceUrl || !sourceUrl.startsWith("postgresql")) {
  console.error(
    "Could not read DATABASE_URL from web app envs or database API. Set DATABASE_URL on the web app or COOLIFY_POSTGRES_UUID.",
  );
  process.exit(1);
}

const endpoint = extractPublicHostPort(detailData, sourceUrl);
if (!endpoint) {
  console.error(
    "Could not resolve public host/port. Set COOLIFY_POSTGRES_PUBLIC_HOST and COOLIFY_POSTGRES_PUBLIC_PORT, or ensure GET /databases/{uuid} exposes port mapping (e.g. 3000:5432).",
  );
  process.exit(1);
}

const publicUrl = rewritePostgresHostPort(sourceUrl, endpoint.host, endpoint.port);

if (!publicUrl || !publicUrl.startsWith("postgresql")) {
  console.error("Failed to rewrite DATABASE_URL for worker.");
  process.exit(1);
}

if (webDatabaseUrl) {
  console.log("Using database name + credentials from WMS web DATABASE_URL (host/port rewritten for worker).");
} else {
  console.log("Web DATABASE_URL missing or unreadable; using database resource internal URL as template.");
}

const redact = (u) => u.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://***:***@");
console.log("Worker will get DATABASE_URL (redacted):", redact(publicUrl));

const bulk = [
  {
    key: "DATABASE_URL",
    value: publicUrl,
    is_literal: true,
    is_multiline: false,
    is_runtime: true,
    is_buildtime: true,
  },
];

if (dryRun) {
  console.log("DRY RUN: would PATCH worker envs/bulk with DATABASE_URL only.");
  process.exit(0);
}

const patchRes = await fetch(`${base}/applications/${workerUuid}/envs/bulk`, {
  method: "PATCH",
  headers: h,
  body: JSON.stringify({ data: bulk }),
});
const patchText = await patchRes.text();
console.log("PATCH worker envs:", patchRes.status, patchText.slice(0, 120).replace(/postgresql:[^"]+/g, "postgresql://[redacted]"));
if (!patchRes.ok) process.exit(1);

if (noDeploy) {
  console.log("Skipped deploy (--no-deploy). Run: npm run deploy:coolify:worker");
  process.exit(0);
}

const deployPath = `${base}/deploy?uuid=${encodeURIComponent(workerUuid)}&force=false`;
const dRes = await fetch(deployPath, { method: "POST", headers: h });
const dBody = await dRes.text();
console.log("Deploy:", dRes.status, dBody.slice(0, 200));

if (!dRes.ok) process.exit(1);

let depUuid = null;
try {
  const j = JSON.parse(dBody);
  depUuid = j?.deployments?.[0]?.deployment_uuid ?? j?.deployment_uuid ?? null;
} catch {
  /* ignore */
}
if (depUuid) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "poll-coolify-deployment.mjs"), depUuid], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

process.exit(0);
