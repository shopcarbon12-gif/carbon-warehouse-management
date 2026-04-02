/**
 * Remove public domain(s) from the sync worker app (sslip.io noise). PATCH /applications/{uuid}.
 * Loads COOLIFY_WORKER_APP_UUID + token from .env.coolify.local.
 *
 * Usage: node scripts/coolify-clear-worker-public-url.mjs [--dry-run]
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
  console.error("Need COOLIFY_API_TOKEN, COOLIFY_WORKER_APP_UUID, COOLIFY_DEPLOY_WEBHOOK_URL in .env.coolify.local");
  process.exit(1);
}

const h = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };

const getRes = await fetch(`${base}/applications/${workerUuid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
const app = await getRes.json();
if (!getRes.ok) {
  console.error("GET application failed:", getRes.status, app);
  process.exit(1);
}

console.log("Current fqdn:", app.fqdn || "(empty)");
console.log("Current domains field:", app.domains ?? "(missing)");

const patchBody = {
  domains: "",
  is_force_https_enabled: false,
};

if (dryRun) {
  console.log("DRY RUN: would PATCH", patchBody);
  process.exit(0);
}

const patchRes = await fetch(`${base}/applications/${workerUuid}`, {
  method: "PATCH",
  headers: h,
  body: JSON.stringify(patchBody),
});
const patchOut = await patchRes.text();
console.log("PATCH status:", patchRes.status, patchOut.slice(0, 400));

if (!patchRes.ok) {
  console.error("If PATCH failed, clear the domain manually in Coolify → worker → Configuration → Domains.");
  process.exit(1);
}

console.log("Done. If sslip URL still shows, Redeploy the worker once from Coolify.");
