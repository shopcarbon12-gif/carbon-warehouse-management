/**
 * Same as trigger-coolify-deploy.mjs but uses COOLIFY_WORKER_DEPLOY_WEBHOOK_URL.
 * Set that in .env.coolify.local (Application → Webhooks on the worker app), or run
 * scripts/coolify-provision-sync-worker.mjs once and copy the printed URL.
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
    if (key !== "COOLIFY_WORKER_DEPLOY_WEBHOOK_URL" && key !== "COOLIFY_API_TOKEN") continue;
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

const url = process.env.COOLIFY_WORKER_DEPLOY_WEBHOOK_URL?.trim();
if (!url) {
  console.error(
    "COOLIFY_WORKER_DEPLOY_WEBHOOK_URL missing. Add to .env.coolify.local (worker app → Configuration → Webhooks), or run: node scripts/coolify-provision-sync-worker.mjs",
  );
  process.exit(1);
}

const token = process.env.COOLIFY_API_TOKEN?.trim();
const headers = { Accept: "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;

async function trigger(method) {
  return fetch(url, { method, headers });
}

let res = await trigger("POST");
let body = await res.text();
if (!res.ok && (res.status === 401 || res.status === 405)) {
  const r2 = await trigger("GET");
  const b2 = await r2.text();
  if (r2.ok) {
    res = r2;
    body = b2;
  } else {
    res = r2;
    body = b2;
  }
}

console.log(res.status, res.statusText, body ? body.slice(0, 300) : "");
process.exit(res.ok ? 0 : 1);
