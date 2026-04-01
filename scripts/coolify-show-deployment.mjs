/**
 * One-shot: GET /api/v1/deployments/{uuid} and print status + logs (for debugging failed deploys).
 * Usage: node scripts/coolify-show-deployment.mjs <deployment_uuid>
 * Env: COOLIFY_DEPLOY_WEBHOOK_URL + COOLIFY_API_TOKEN (or .env.coolify.local).
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
  console.error("Usage: node scripts/coolify-show-deployment.mjs <deployment_uuid>");
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
  const { protocol, host } = new URL(webhook);
  base = `${protocol}//${host}/api/v1`;
}
base = base.replace(/\/$/, "");

const url = `${base}/deployments/${deploymentUuid}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
if (!res.ok) {
  console.error(res.status, text.slice(0, 500));
  process.exit(1);
}
let j;
try {
  j = JSON.parse(text);
} catch {
  console.error("Invalid JSON", text.slice(0, 300));
  process.exit(1);
}

console.log("status:", j.status ?? j.deployment?.status ?? "(unknown)");
console.log("commit:", j.commit ?? j.git_commit ?? "");
const logs = j.logs ?? j.deployment?.logs ?? j.build_logs ?? "";
if (typeof logs === "string" && logs.length > 0) {
  const tail = logs.length > 12000 ? logs.slice(-12000) : logs;
  console.log("\n--- logs (tail) ---\n");
  console.log(tail);
} else {
  console.log("\n(no logs string in response; raw keys:", Object.keys(j).join(", "), ")");
}
