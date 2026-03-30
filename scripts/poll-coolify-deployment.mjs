/**
 * Poll GET /api/v1/deployments/{uuid} until finished (or timeout).
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL + COOLIFY_API_TOKEN from .env.coolify.local (same as trigger script).
 * Usage: node scripts/poll-coolify-deployment.mjs <deployment_uuid>
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

const deploymentUuid = process.argv[2]?.trim();
if (!deploymentUuid) {
  console.error("Usage: node scripts/poll-coolify-deployment.mjs <deployment_uuid>");
  process.exit(1);
}

const webhook = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
const token = process.env.COOLIFY_API_TOKEN?.trim();
if (!webhook || !token) {
  console.error("Need COOLIFY_DEPLOY_WEBHOOK_URL and COOLIFY_API_TOKEN (.env.coolify.local).");
  process.exit(1);
}

let base = process.env.COOLIFY_BASE_URL?.trim();
if (!base) {
  try {
    const { protocol, host } = new URL(webhook);
    base = `${protocol}//${host}/api/v1`;
  } catch {
    console.error("Could not parse COOLIFY_DEPLOY_WEBHOOK_URL");
    process.exit(1);
  }
}
base = base.replace(/\/$/, "");

const url = `${base}/deployments/${deploymentUuid}`;
const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

const terminal = new Set(["finished", "failed", "cancelled", "canceled"]);

async function once() {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${text.slice(0, 200)}` };
  }
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

const maxMs = 20 * 60 * 1000;
const intervalMs = 8000;
const start = Date.now();

while (Date.now() - start < maxMs) {
  const r = await once();
  if (!r.ok) {
    console.error("poll:", r.error);
    process.exit(1);
  }
  const d = r.json;
  const status = d?.status ?? d?.deployment?.status ?? d?.data?.status ?? JSON.stringify(d).slice(0, 120);
  console.log(new Date().toISOString(), "status:", status);

  const s = String(status).toLowerCase();
  if (terminal.has(s)) {
    if (s === "finished") {
      console.log("Deployment finished successfully.");
      process.exit(0);
    }
    console.error("Deployment ended with:", status);
    process.exit(1);
  }

  await new Promise((x) => setTimeout(x, intervalMs));
}

console.error("Timeout waiting for deployment.");
process.exit(1);
