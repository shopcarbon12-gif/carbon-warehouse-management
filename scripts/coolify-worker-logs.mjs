/**
 * GET /api/v1/applications/{uuid}/logs — tail worker logs (Coolify API).
 * Env: .env.coolify.local — COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, COOLIFY_WORKER_APP_UUID
 * Usage: node scripts/coolify-worker-logs.mjs [lines]
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadLocal();

const lines = Math.min(500, Math.max(20, Number(process.argv[2]) || 150));
const token = process.env.COOLIFY_API_TOKEN?.trim();
const workerUuid = process.env.COOLIFY_WORKER_APP_UUID?.trim();
const wh = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
const { protocol, host } = new URL(wh);
const base = (process.env.COOLIFY_BASE_URL || `${protocol}//${host}/api/v1`).replace(/\/$/, "");

if (!token || !workerUuid) {
  console.error("Need COOLIFY_API_TOKEN, COOLIFY_WORKER_APP_UUID");
  process.exit(1);
}

const url = `${base}/applications/${workerUuid}/logs?lines=${lines}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
const text = await res.text();
console.log("HTTP", res.status);
if (!res.ok) {
  console.log(text.slice(0, 800));
  process.exit(1);
}
try {
  const j = JSON.parse(text);
  const logs = j.logs ?? j.data ?? j;
  console.log(typeof logs === "string" ? logs : JSON.stringify(logs, null, 2).slice(0, 20000));
} catch {
  console.log(text.slice(0, 20000));
}
