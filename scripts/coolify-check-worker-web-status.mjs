/**
 * One-shot: compare WMS web vs sync worker app (domains, health check, Dockerfile) + recent deployments.
 * Loads .env.coolify.local (COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID).
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

const token = process.env.COOLIFY_API_TOKEN?.trim();
const webhook = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
const workerUuid = process.env.COOLIFY_WORKER_APP_UUID?.trim();
const m = webhook.match(/[?&]uuid=([^&]+)/);
const webUuid = m ? decodeURIComponent(m[1]) : "";

let base = process.env.COOLIFY_BASE_URL?.trim();
if (!base) {
  try {
    const { protocol, host } = new URL(webhook);
    base = `${protocol}//${host}/api/v1`;
  } catch {
    base = "";
  }
}
base = base.replace(/\/$/, "");

if (!token || !base || !webUuid) {
  console.error("Need COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL in .env.coolify.local");
  process.exit(1);
}

const h = { Authorization: `Bearer ${token}`, Accept: "application/json" };

async function getApp(uuid) {
  const r = await fetch(`${base}/applications/${uuid}`, { headers: h });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

async function getDeps(uuid) {
  const r = await fetch(`${base}/deployments/applications/${uuid}`, { headers: h });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = { raw: t.slice(0, 200) };
  }
  return { ok: r.ok, status: r.status, j };
}

function pickApp(a) {
  const j = a.j;
  return {
    api: a.ok ? "ok" : `error ${a.status}`,
    name: j.name,
    coolify_status: j.status,
    fqdn: j.fqdn || "(none — no public URL)",
    health_check_enabled: Boolean(j.health_check_enabled),
    dockerfile_location: j.dockerfile_location,
    ports_exposes: j.ports_exposes,
    last_online_at: j.last_online_at,
    server_status: j.server_status,
  };
}

function pickDeps(d) {
  if (!d.ok) return { api: `error ${d.status}` };
  const list = Array.isArray(d.j) ? d.j : d.j?.deployments ?? d.j?.data ?? [];
  const recent = list.slice(0, 6).map((x) => ({
    status: x.status,
    commit: (x.commit || "").slice(0, 7),
    message: (x.commit_message || "").slice(0, 60),
    finished_at: x.finished_at || x.updated_at,
  }));
  const finished = list.find((x) => String(x.status).toLowerCase() === "finished");
  const inProg = list.find((x) => String(x.status).toLowerCase() === "in_progress");
  return {
    api: "ok",
    recent,
    latest_finished_commit: finished?.commit ? String(finished.commit).slice(0, 7) : null,
    latest_finished_at: finished?.finished_at,
    in_progress: inProg
      ? { commit: String(inProg.commit || "").slice(0, 7), status: inProg.status }
      : null,
  };
}

const webApp = await getApp(webUuid);
const webDep = await getDeps(webUuid);

const out = {
  checked_at: new Date().toISOString(),
  wms_web: {
    uuid: webUuid,
    application: pickApp(webApp),
    deployments: pickDeps(webDep),
  },
};

if (workerUuid) {
  const workerApp = await getApp(workerUuid);
  const workerDep = await getDeps(workerUuid);
  out.sync_worker = {
    uuid: workerUuid,
    application: pickApp(workerApp),
    deployments: pickDeps(workerDep),
  };
} else {
  out.sync_worker = { note: "Set COOLIFY_WORKER_APP_UUID in .env.coolify.local" };
}

console.log(JSON.stringify(out, null, 2));
