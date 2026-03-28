/**
 * POSTs Coolify’s deploy API URL (Application → Configuration → Webhooks).
 * Loads COOLIFY_DEPLOY_WEBHOOK_URL and COOLIFY_API_TOKEN from process env, or from
 * repo-root `.env.coolify.local` if unset (same keys only).
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
    if (key !== "COOLIFY_DEPLOY_WEBHOOK_URL" && key !== "COOLIFY_API_TOKEN") {
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

const token = process.env.COOLIFY_API_TOKEN?.trim();
const headers = { Accept: "application/json" };
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const res = await fetch(url, { method: "POST", headers });
const body = await res.text();
console.log(res.status, res.statusText, body ? body.slice(0, 300) : "");
if (res.status === 401 && !token) {
  console.error(
    "401: add COOLIFY_API_TOKEN to .env.coolify.local (Coolify → Security → API Tokens, deploy scope).",
  );
}
process.exit(res.ok ? 0 : 1);
