/**
 * Exactly ONE Coolify deploy: POST webhook once, then poll until terminal.
 * Does not re-queue on failure (no second webhook).
 *
 * Why this exists: `deploy:coolify:watch` always calls the webhook at the start of each
 * attempt. Running `deploy:coolify` and then `deploy:coolify:watch` stacks two deploys.
 *
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL + COOLIFY_API_TOKEN from env or `.env.coolify.local`.
 *
 * Poll-only (no webhook): set COOLIFY_DEPLOYMENT_UUID and COOLIFY_SKIP_DEPLOY_TRIGGER=1
 * to wait for an already-queued deployment.
 *
 * Env: COOLIFY_POLL_TIMEOUT_MS (default 1200000), COOLIFY_POLL_INTERVAL_MS (default 8000)
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
    if (key !== "COOLIFY_DEPLOY_WEBHOOK_URL" && key !== "COOLIFY_API_TOKEN") continue;
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

const webhookUrl = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
const token = process.env.COOLIFY_API_TOKEN?.trim();
const skipTrigger =
  process.env.COOLIFY_SKIP_DEPLOY_TRIGGER === "1" || process.env.COOLIFY_SKIP_DEPLOY_TRIGGER === "true";
const existingUuid = process.env.COOLIFY_DEPLOYMENT_UUID?.trim();

const pollTimeoutMs = Math.max(60_000, Number(process.env.COOLIFY_POLL_TIMEOUT_MS ?? 1_200_000) || 1_200_000);
const pollIntervalMs = Math.max(3000, Number(process.env.COOLIFY_POLL_INTERVAL_MS ?? 8000) || 8000);

if (!token) {
  console.error("COOLIFY_API_TOKEN required. Add to .env.coolify.local.");
  process.exit(1);
}

if (!skipTrigger && !webhookUrl) {
  console.error("COOLIFY_DEPLOY_WEBHOOK_URL missing (or set COOLIFY_SKIP_DEPLOY_TRIGGER=1 + COOLIFY_DEPLOYMENT_UUID).");
  process.exit(1);
}

if (skipTrigger && !existingUuid) {
  console.error("COOLIFY_SKIP_DEPLOY_TRIGGER=1 requires COOLIFY_DEPLOYMENT_UUID.");
  process.exit(1);
}

function apiBaseFromWebhook() {
  let base = process.env.COOLIFY_BASE_URL?.trim();
  if (base) return base.replace(/\/$/, "");
  try {
    const { protocol, host } = new URL(webhookUrl);
    return `${protocol}//${host}/api/v1`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const apiBase = apiBaseFromWebhook();
if (!apiBase) {
  console.error("Could not derive Coolify API base URL.");
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${token}`, Accept: "application/json" };

async function triggerDeploy() {
  const headers = { Accept: "application/json", ...authHeaders };
  let res = await fetch(webhookUrl, { method: "POST", headers });
  let body = await res.text();
  if (!res.ok && (res.status === 401 || res.status === 405)) {
    const r2 = await fetch(webhookUrl, { method: "GET", headers });
    const b2 = await r2.text();
    if (r2.ok) {
      res = r2;
      body = b2;
    }
  }
  if (!res.ok) {
    console.error("Trigger failed:", res.status, body.slice(0, 400));
    return null;
  }
  let uuid = null;
  try {
    const j = JSON.parse(body);
    const dep = j?.deployments?.[0] ?? j?.deployment ?? j;
    uuid = dep?.deployment_uuid ?? dep?.uuid ?? j?.deployment_uuid ?? null;
  } catch {
    /* ignore */
  }
  if (!uuid) {
    console.error("Trigger OK but no deployment_uuid in body:", body.slice(0, 400));
    return null;
  }
  console.log("Single deploy queued, deployment_uuid:", uuid);
  return uuid;
}

const terminal = new Set(["finished", "failed", "cancelled", "canceled"]);

async function pollUntilTerminal(deploymentUuid) {
  const url = `${apiBase}/deployments/${deploymentUuid}`;
  const start = Date.now();

  while (Date.now() - start < pollTimeoutMs) {
    let res;
    let text;
    try {
      res = await fetch(url, { headers: authHeaders });
      text = await res.text();
    } catch (e) {
      console.error("poll fetch error:", e?.message ?? e);
      return "poll_error";
    }
    if (!res.ok) {
      console.error("poll HTTP", res.status, text.slice(0, 200));
      return "poll_error";
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      console.error("poll: invalid JSON", text.slice(0, 120));
      return "poll_error";
    }
    const status =
      j?.status ?? j?.deployment?.status ?? j?.data?.status ?? String(j?.state ?? "").trim();
    const s = String(status).toLowerCase();
    console.log(new Date().toISOString(), "deployment status:", status);

    if (terminal.has(s) || s.startsWith("cancel")) {
      if (s === "finished") return "finished";
      if (s === "cancelled" || s === "canceled" || s.startsWith("cancel")) return "cancelled";
      return "failed";
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return "timeout";
}

let uuid = existingUuid;
if (!skipTrigger) {
  uuid = await triggerDeploy();
  if (!uuid) process.exit(1);
} else {
  console.log("Skipping webhook (COOLIFY_SKIP_DEPLOY_TRIGGER); polling:", uuid);
}

const outcome = await pollUntilTerminal(uuid);
if (outcome === "finished") {
  console.log("\nCoolify deployment finished successfully.\n");
  process.exit(0);
}

console.error(`\nDeployment ended: ${outcome} (uuid ${uuid})\n`);
process.exit(1);
