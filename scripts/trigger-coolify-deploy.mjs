/**
 * Calls Coolify’s deploy webhook (Application → Configuration → Webhooks): POST first,
 * then GET if POST returns 401/405 (some instances expect GET).
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_DEPLOY_WEBHOOK_URL and
 * COOLIFY_API_TOKEN from process env, or from repo-root `.env.coolify.local` if
 * unset (same keys only).
 *
 * Deploys BOTH applications. The web app serves the UI and API; the separate
 * `carbon-wms-sync-worker` runs the queued jobs — Shopify product pushes,
 * inventory sync. Deploying only the web app leaves the worker on old code, and
 * the symptom is a Check & Publish that still fails on a rule you just changed
 * (2026-09-22). Skipped, with a warning, when the worker webhook is not set.
 * @see README.md
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");

function loadCoolifyLocal() {
  if (!fs.existsSync(dotenvPath)) return;
  let text = fs.readFileSync(dotenvPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    if (
      key !== "COOLIFY_DEPLOY_WEBHOOK_URL" &&
      key !== "COOLIFY_WORKER_DEPLOY_WEBHOOK_URL" &&
      key !== "COOLIFY_API_TOKEN"
    ) {
      continue;
    }
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

loadCoolifyLocal();

const url = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
if (!url) {
  console.error(
    "COOLIFY_DEPLOY_WEBHOOK_URL missing. Set it or add to .env.coolify.local (see Coolify → WMS → Webhooks).",
  );
  process.exit(1);
}
const workerUrl = process.env.COOLIFY_WORKER_DEPLOY_WEBHOOK_URL?.trim();
if (!workerUrl) {
  console.warn(
    "COOLIFY_WORKER_DEPLOY_WEBHOOK_URL not set — deploying the web app only. Queued jobs (Shopify publish, inventory sync) will keep running the previous code.",
  );
}

const token = process.env.COOLIFY_API_TOKEN?.trim();
const headers = { Accept: "application/json" };
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

/** Coolify accepts POST; some setups / docs use GET on the same webhook URL. */
async function trigger(target, method) {
  return fetch(target, { method, headers });
}

async function deploy(name, target) {
  let res = await trigger(target, "POST");
  let body = await res.text();
  if (!res.ok && (res.status === 401 || res.status === 405)) {
    const r2 = await trigger(target, "GET");
    const b2 = await r2.text();
    if (r2.ok || res.status === 405) {
      res = r2;
      body = b2;
    }
  }
  console.log(`${name}: ${res.status} ${res.statusText} ${body ? body.slice(0, 300) : ""}`);
  return res;
}

const res = await deploy("web app", url);
const workerRes = workerUrl ? await deploy("sync worker", workerUrl) : null;
if (res.status === 401) {
  if (!token) {
    console.error(
      "401: add COOLIFY_API_TOKEN to .env.coolify.local (Coolify → Security → API Tokens, deploy or root).",
    );
  } else {
    console.error(
      "401: token rejected — create a new API token in Coolify, paste into COOLIFY_API_TOKEN (shown once).",
    );
  }
}
process.exit(res.ok && (!workerRes || workerRes.ok) ? 0 : 1);
