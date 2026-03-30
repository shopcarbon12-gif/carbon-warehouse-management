/**
 * End-to-end: trigger Coolify deploy → poll until finished/failed/cancelled → on failure, re-queue and poll again.
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL + COOLIFY_API_TOKEN from env or `.env.coolify.local` (same keys as trigger script).
 *
 * Env:
 *   COOLIFY_WATCH_MAX_ATTEMPTS (default 5) — full trigger+poll cycles on failure
 *   COOLIFY_POLL_TIMEOUT_MS (default 1200000) — 20 minutes per deployment
 *   COOLIFY_POLL_INTERVAL_MS (default 8000)
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

const maxAttempts = Math.max(1, Number(process.env.COOLIFY_WATCH_MAX_ATTEMPTS ?? 5) || 5);
const pollTimeoutMs = Math.max(60_000, Number(process.env.COOLIFY_POLL_TIMEOUT_MS ?? 1_200_000) || 1_200_000);
const pollIntervalMs = Math.max(3000, Number(process.env.COOLIFY_POLL_INTERVAL_MS ?? 8000) || 8000);

if (!webhookUrl) {
  console.error(
    "COOLIFY_DEPLOY_WEBHOOK_URL missing. Set it or add to .env.coolify.local (see Coolify → Webhooks).",
  );
  process.exit(1);
}

if (!token) {
  console.error(
    "COOLIFY_API_TOKEN required for deploy watch (polling GET /api/v1/deployments/{uuid}). Add to .env.coolify.local.",
  );
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
  console.error("Could not derive Coolify API base URL from COOLIFY_DEPLOY_WEBHOOK_URL.");
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
  console.log("Deploy queued, deployment_uuid:", uuid);
  return uuid;
}

const terminal = new Set(["finished", "failed", "cancelled", "canceled"]);

/**
 * @returns {'finished' | 'failed' | 'cancelled' | 'timeout' | 'poll_error'}
 */
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

    if (terminal.has(s)) {
      if (s === "finished") return "finished";
      return s === "cancelled" || s === "canceled" ? "cancelled" : "failed";
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return "timeout";
}

const retryDelayMs = Math.max(10_000, Number(process.env.COOLIFY_WATCH_RETRY_DELAY_MS ?? 20_000) || 20_000);

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  console.log(`\n=== Deploy watch attempt ${attempt}/${maxAttempts} ===\n`);
  const uuid = await triggerDeploy();
  if (!uuid) {
    console.error("Aborting: could not queue deployment.");
    if (attempt < maxAttempts) {
      console.log(`Retrying trigger in ${retryDelayMs / 1000}s…`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    continue;
  }

  const outcome = await pollUntilTerminal(uuid);
  if (outcome === "finished") {
    console.log("\nCoolify deployment finished successfully.\n");
    process.exit(0);
  }

  console.error(`\nDeployment ended: ${outcome} (uuid ${uuid})\n`);
  if (attempt < maxAttempts) {
    console.log(`Re-queueing in ${retryDelayMs / 1000}s…`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
}

console.error("Giving up after", maxAttempts, "attempt(s). Check Coolify UI and application logs.");
process.exit(1);
