/**
 * GET /api/v1/deployments/applications/{uuid} — print latest deployment fields (commit if present).
 * Loads .env.coolify.local (COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, optional COOLIFY_BASE_URL).
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

const token = process.env.COOLIFY_API_TOKEN?.trim();
let base = process.env.COOLIFY_BASE_URL?.trim();
if (!base) {
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  try {
    const { protocol, host } = new URL(u);
    base = `${protocol}//${host}/api/v1`;
  } catch {
    base = "";
  }
}
base = base.replace(/\/$/, "");

const appUuid =
  process.env.COOLIFY_APPLICATION_UUID?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();

if (!token || !base || !appUuid) {
  console.error("Need COOLIFY_API_TOKEN, API base, app uuid (webhook ?uuid=).");
  process.exit(1);
}

const url = `${base}/deployments/applications/${appUuid}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
if (!res.ok) {
  console.error(res.status, text.slice(0, 600));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(text);
} catch {
  console.error("Non-JSON", text.slice(0, 400));
  process.exit(1);
}

const list = Array.isArray(data) ? data : data.deployments ?? data.data ?? [];
console.log("deployments returned:", list.length);

function shortSha(c) {
  if (!c || typeof c !== "string") return "";
  return c.length >= 7 ? c.slice(0, 7) : c;
}

console.log("\n--- Recent deployments (newest first) ---\n");
for (const d of list.slice(0, 8)) {
  console.log(
    [d.status, shortSha(d.commit), (d.commit_message || "").slice(0, 60), d.finished_at || d.updated_at].join(
      " | ",
    ),
  );
}

const latest = list[0];
const latestFinished = list.find((d) => String(d.status).toLowerCase() === "finished");

if (latestFinished) {
  console.log("\n--- Latest FINISHED deployment ---\n");
  console.log("commit:", latestFinished.commit);
  console.log("short:", shortSha(latestFinished.commit));
  console.log("finished_at:", latestFinished.finished_at);
  console.log("message:", (latestFinished.commit_message || "").slice(0, 200));
}

if (!latest) {
  console.log("No deployments in response.");
  process.exit(0);
}

console.log("\n--- Newest row (may be in_progress) ---\n");
console.log("status:", latest.status);
console.log("commit:", latest.commit);
console.log("message:", (latest.commit_message || "").slice(0, 200));
