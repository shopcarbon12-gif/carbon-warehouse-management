/**
 * Set carbon-wms-sync-worker DATABASE_URL from Coolify GET /databases/{uuid} internal_db_url.
 *
 * The WMS web app sometimes stores a longer hostname (postgresql-database-…) that resolves only
 * for certain stacks; the API’s internal_db_url uses the short service name (e.g. {uuid}:5432)
 * that resolves on the shared `coolify` Docker network with the worker.
 *
 * Loads .env.coolify.local: COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID,
 * optional COOLIFY_POSTGRES_UUID, COOLIFY_POSTGRES_NAME_SUBSTR.
 *
 * Usage:
 *   node scripts/coolify-worker-sync-internal-database-url.mjs
 *   node scripts/coolify-worker-sync-internal-database-url.mjs --dry-run
 *   node scripts/coolify-worker-sync-internal-database-url.mjs --no-deploy
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
  console.error("Need COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID.");
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

function normalizePostgresUrl(v) {
  if (typeof v !== "string" || v.length < 12) return "";
  if (v.startsWith("postgresql://")) return v;
  if (v.startsWith("postgres://")) return `postgresql://${v.slice("postgres://".length)}`;
  return "";
}

function pickInternalUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  const keys = ["internal_db_url", "internal_url", "postgres_url", "database_url", "connection_string"];
  for (const k of keys) {
    const v = obj[k];
    const n = normalizePostgresUrl(typeof v === "string" ? v : "");
    if (n) return n;
  }
  return "";
}

/** Only rewrite when web uses Coolify’s long DNS name (worker cannot resolve it). External RDS URLs stay unchanged. */
function isCoolifyLongPostgresDNSHostname(webUrl) {
  const wn = normalizePostgresUrl(webUrl);
  if (!wn) return false;
  try {
    return new URL(wn.replace(/^postgresql:/i, "http:")).hostname.toLowerCase().includes("postgresql-database-");
  } catch {
    return false;
  }
}

/** Use Docker host:port from Coolify internal URL; keep path + user + password + query from web (same DB as Next.js). */
function applyInternalHostToWebDatabaseUrl(webUrl, internalUrl) {
  const wn = normalizePostgresUrl(webUrl);
  const inn = normalizePostgresUrl(internalUrl);
  if (!wn || !inn) return inn || wn;
  try {
    const i = new URL(inn.replace(/^postgresql:/i, "http:"));
    const w = new URL(wn.replace(/^postgresql:/i, "http:"));
    const host = i.hostname;
    const port = i.port || "5432";
    const user = safeDecode(w.username || "postgres");
    const pass = safeDecode(w.password || "");
    const path = w.pathname || "/postgres";
    const search = w.search || "";
    const encU = encodeURIComponent(user);
    const encP = encodeURIComponent(pass);
    const auth = pass ? `${encU}:${encP}` : encU;
    return `postgresql://${auth}@${host}:${port}${path}${search}`;
  } catch {
    return inn;
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
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

if (!internalUrl) {
  console.error("Could not read internal_db_url from database resource.");
  process.exit(1);
}

const { res: webEnvRes, data: webEnvRows } = await apiGet(`/applications/${webUuid}/envs`);
let webDb = "";
if (webEnvRes.ok && Array.isArray(webEnvRows)) {
  const row = webEnvRows.find((r) => r.key === "DATABASE_URL");
  const raw = row?.real_value ?? row?.value ?? "";
  webDb = typeof raw === "string" ? raw.trim() : "";
  if ((webDb.startsWith("'") && webDb.endsWith("'")) || (webDb.startsWith('"') && webDb.endsWith('"'))) {
    webDb = webDb.slice(1, -1).trim();
  }
}

const finalUrl =
  webDb && isCoolifyLongPostgresDNSHostname(webDb)
    ? applyInternalHostToWebDatabaseUrl(webDb, internalUrl)
    : webDb
      ? normalizePostgresUrl(webDb.startsWith("postgres://") ? `postgresql://${webDb.slice("postgres://".length)}` : webDb)
      : internalUrl;

if (!finalUrl) {
  console.error("Could not build worker DATABASE_URL.");
  process.exit(1);
}

const redact = (u) => u.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://***:***@");
console.log("Worker DATABASE_URL (redacted):", redact(finalUrl));
if (webDb && isCoolifyLongPostgresDNSHostname(webDb)) {
  console.log("(Host/port from Coolify internal_db_url; database name + credentials from web DATABASE_URL.)");
} else if (webDb) {
  console.log("(Web DATABASE_URL does not use postgresql-database-… host; copied normalized web URL to worker.)");
} else {
  console.log("(Web DATABASE_URL unreadable; using internal_db_url only.)");
}
console.log("Postgres resource uuid:", pgUuid);

const bulk = [
  {
    key: "DATABASE_URL",
    value: finalUrl,
    is_literal: true,
    is_multiline: false,
    is_runtime: true,
    is_buildtime: true,
  },
];

if (dryRun) {
  console.log("DRY RUN: would PATCH worker envs/bulk.");
  process.exit(0);
}

const patchRes = await fetch(`${base}/applications/${workerUuid}/envs/bulk`, {
  method: "PATCH",
  headers: h,
  body: JSON.stringify({ data: bulk }),
});
const patchText = await patchRes.text();
console.log("PATCH worker envs:", patchRes.status, patchText.slice(0, 100).replace(/postgresql:[^"]+/g, "postgresql://[redacted]"));
if (!patchRes.ok) process.exit(1);

if (noDeploy) {
  console.log("Skipped deploy. Run: npm run deploy:coolify:worker");
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
