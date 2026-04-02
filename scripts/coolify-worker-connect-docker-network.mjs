/**
 * Enable Coolify "connect to Docker network" on the sync worker app so it can resolve
 * internal Postgres hostnames (e.g. postgresql-database-…) copied from the web app.
 *
 * Loads .env.coolify.local: COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL (for API base),
 * COOLIFY_WORKER_APP_UUID.
 *
 * Usage:
 *   node scripts/coolify-worker-connect-docker-network.mjs
 *   node scripts/coolify-worker-connect-docker-network.mjs --dry-run
 *   node scripts/coolify-worker-connect-docker-network.mjs --no-deploy
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

const dryRun = process.argv.includes("--dry-run");
const noDeploy = process.argv.includes("--no-deploy");

const token = process.env.COOLIFY_API_TOKEN?.trim();
const workerUuid = process.env.COOLIFY_WORKER_APP_UUID?.trim();
const webhook = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
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

if (!token || !base || !workerUuid) {
  console.error(
    "Need COOLIFY_API_TOKEN, COOLIFY_WORKER_APP_UUID, COOLIFY_DEPLOY_WEBHOOK_URL in .env.coolify.local",
  );
  process.exit(1);
}

const h = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const getRes = await fetch(`${base}/applications/${workerUuid}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const app = await getRes.json();
if (!getRes.ok) {
  console.error("GET application failed:", getRes.status, app);
  process.exit(1);
}

const current = Boolean(app.connect_to_docker_network);
console.log("Worker app:", app.name || workerUuid);
console.log("connect_to_docker_network (current):", current);

if (current) {
  console.log("Already enabled. Nothing to PATCH.");
  if (!noDeploy) {
    console.log("Run npm run deploy:coolify:worker if you still need a fresh deploy.");
  }
  process.exit(0);
}

const patchBody = { connect_to_docker_network: true };

if (dryRun) {
  console.log("DRY RUN: would PATCH", patchBody);
  process.exit(0);
}

const patchRes = await fetch(`${base}/applications/${workerUuid}`, {
  method: "PATCH",
  headers: h,
  body: JSON.stringify(patchBody),
});
const patchText = await patchRes.text();
console.log("PATCH status:", patchRes.status, patchText.slice(0, 400));

if (!patchRes.ok) {
  console.error(
    "PATCH failed. Enable “Connect to Docker network” (or equivalent) manually on the worker app in Coolify UI.",
  );
  process.exit(1);
}

console.log("connect_to_docker_network set to true. Redeploy the worker so the container joins the network.");

if (noDeploy) {
  process.exit(0);
}

const deployPath = `${base}/deploy?uuid=${encodeURIComponent(workerUuid)}&force=false`;
const dRes = await fetch(deployPath, { method: "POST", headers: h });
const dBody = await dRes.text();
console.log("Deploy trigger:", dRes.status, dBody.slice(0, 300));

if (!dRes.ok) {
  console.error("Deploy trigger failed. Run: npm run deploy:coolify:worker");
  process.exit(1);
}

let depUuid = null;
try {
  const j = JSON.parse(dBody);
  depUuid = j?.deployments?.[0]?.deployment_uuid ?? j?.deployment_uuid ?? null;
} catch {
  /* ignore */
}
if (depUuid) {
  console.log("Polling deployment:", depUuid);
  const { spawnSync } = await import("node:child_process");
  const pollScript = path.join(root, "scripts", "poll-coolify-deployment.mjs");
  const r = spawnSync(process.execPath, [pollScript, depUuid], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

console.log("Deploy queued (no deployment_uuid in body). Check Coolify UI.");
process.exit(0);
