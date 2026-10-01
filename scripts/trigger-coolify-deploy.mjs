/**
 * Calls Coolify’s deploy webhook (Application → Configuration → Webhooks): POST first,
 * then GET if POST returns 401/405 (some instances expect GET).
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_DEPLOY_WEBHOOK_URL and
 * COOLIFY_API_TOKEN from process env, or from repo-root `.env.coolify.local` if
 * unset (same keys only).
 *
 * Deploys BOTH applications, ONE AT A TIME. The web app serves the UI and API;
 * the separate `carbon-wms-sync-worker` runs the queued jobs — Shopify product
 * pushes, inventory sync. Deploying only the web app leaves the worker on old
 * code, and the symptom is a Check & Publish that still fails on a rule you just
 * changed (2026-09-22). Skipped, with a warning, when the worker webhook is not
 * set.
 *
 * WHY IT WAITS: this used to fire both webhooks back to back, so two Next builds
 * ran concurrently on a 8GB box. The web build is the larger of the two and it
 * is the one that got OOM-killed — exit code 255 with no error, right after
 * "Creating an optimized production build". It looked like a flaky deploy for
 * weeks; it was the other build. The web app now goes first and the worker is
 * not triggered until the web deployment reaches a terminal state.
 *
 * Flags:
 *   --web-only      deploy the web app, leave the worker on its current code
 *   --worker-only   deploy the worker only
 *   --no-wait       fire both immediately (the old, racy behaviour)
 *
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

const argv = process.argv.slice(2);
const WEB_ONLY = argv.includes("--web-only");
const WORKER_ONLY = argv.includes("--worker-only");
const NO_WAIT = argv.includes("--no-wait");

const url = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
if (!url && !WORKER_ONLY) {
  console.error(
    "COOLIFY_DEPLOY_WEBHOOK_URL missing. Set it or add to .env.coolify.local (see Coolify → WMS → Webhooks).",
  );
  process.exit(1);
}
const workerUrl = process.env.COOLIFY_WORKER_DEPLOY_WEBHOOK_URL?.trim();
if (!workerUrl && !WEB_ONLY) {
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
  let queued = null;
  try {
    queued = JSON.parse(body)?.deployments?.[0] ?? null;
  } catch {
    /* webhook returned something other than the usual JSON — just don't wait */
  }
  return { res, queued };
}

/* The webhook URL carries the application uuid and the instance origin, which is
   everything the status endpoint needs — no second place to keep in sync. */
function appUuidFrom(target) {
  try {
    const u = new URL(target);
    return { origin: u.origin, uuid: u.searchParams.get("uuid") };
  } catch {
    return { origin: null, uuid: null };
  }
}

const TERMINAL = new Set(["finished", "failed", "cancelled", "error"]);

/** Block until this deployment stops running, so the next build gets the box to
 *  itself. Returns the final status, or null when it cannot be determined. */
async function waitFor(name, target, queued, timeoutMs = 30 * 60 * 1000) {
  const { origin, uuid } = appUuidFrom(target);
  if (!origin || !uuid || !token) {
    console.warn(`${name}: cannot poll status (needs COOLIFY_API_TOKEN and a uuid in the webhook URL) — not waiting.`);
    return null;
  }
  const want = queued?.deployment_uuid;
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15000));
    let list;
    try {
      const r = await fetch(`${origin}/api/v1/deployments/applications/${uuid}?take=5`, { headers });
      if (!r.ok) continue;
      list = (await r.json())?.deployments ?? [];
    } catch {
      continue; /* transient — keep waiting rather than declaring a result */
    }
    const dep = want ? list.find((d) => d.deployment_uuid === want) : list[0];
    if (!dep) continue;
    if (dep.status !== lastStatus) {
      lastStatus = dep.status;
      console.log(`${name}: ${dep.status}`);
    }
    if (TERMINAL.has(dep.status)) return dep.status;
  }
  console.warn(`${name}: still running after ${Math.round(timeoutMs / 60000)} min — not waiting any longer.`);
  return lastStatus || null;
}

let webOk = true;
let workerOk = true;

if (!WORKER_ONLY) {
  const { res, queued } = await deploy("web app", url);
  webOk = res.ok;
  if (res.status === 401) {
    console.error(
      token
        ? "401: token rejected — create a new API token in Coolify, paste into COOLIFY_API_TOKEN (shown once)."
        : "401: add COOLIFY_API_TOKEN to .env.coolify.local (Coolify → Security → API Tokens, deploy or root).",
    );
  }
  /* Wait before the worker is triggered — two builds at once is what kills this one. */
  if (webOk && !NO_WAIT && workerUrl && !WEB_ONLY) {
    const status = await waitFor("web app", url, queued);
    if (status && status !== "finished") webOk = false;
  }
}

if (!WEB_ONLY && workerUrl) {
  const { res } = await deploy("sync worker", workerUrl);
  workerOk = res.ok;
}

process.exit(webOk && workerOk ? 0 : 1);
