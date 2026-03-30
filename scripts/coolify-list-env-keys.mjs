/**
 * Lists environment variable **keys** for a Coolify application (values redacted).
 * Loads .env.coolify.local like other Coolify scripts.
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

function defaultApiBase() {
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  if (!u) return "";
  try {
    const { protocol, host } = new URL(u);
    return `${protocol}//${host}/api/v1`;
  } catch {
    return "";
  }
}

const base = (process.env.COOLIFY_BASE_URL || defaultApiBase()).replace(/\/$/, "");
const token = process.env.COOLIFY_API_TOKEN?.trim();
const appUuid =
  process.env.COOLIFY_APP_UUID?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();

if (!base || !token || !appUuid) {
  console.error("Need COOLIFY_DEPLOY_WEBHOOK_URL (or COOLIFY_BASE_URL), COOLIFY_API_TOKEN, app uuid.");
  process.exit(1);
}

const url = `${base}/applications/${appUuid}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
if (!res.ok) {
  console.error(res.status, text.slice(0, 400));
  process.exit(1);
}
const j = JSON.parse(text);

/** @param {unknown} v */
function collectKeys(v, out) {
  if (!v) return;
  if (Array.isArray(v)) {
    for (const row of v) {
      if (row && typeof row === "object" && "key" in row) out.add(String(row.key));
      else if (row && typeof row === "object" && "name" in row) out.add(String(row.name));
    }
    return;
  }
  if (typeof v === "object") {
    for (const k of Object.keys(v)) out.add(k);
  }
}

const keys = new Set();
for (const prop of [
  "environment_variables",
  "envs",
  "settings",
  "application_settings",
]) {
  collectKeys(j[prop], keys);
}

// Some Coolify versions nest envs
if (j.settings && typeof j.settings === "object") {
  collectKeys(j.settings.environment_variables, keys);
}

console.log("Coolify application env-related keys found in GET /applications/{uuid}:");
if (keys.size === 0) {
  console.log("(none — API may not return env list on this token/version; use UI or envs/bulk read endpoint.)");
  console.log("Top-level response keys:", Object.keys(j).join(", "));
} else {
  console.log([...keys].sort().join("\n"));
}

const has = (k) => keys.has(k) || keys.has(k.toLowerCase());
console.log("\nChecklist (presence of key name only):");
console.log("  DATABASE_URL:", has("DATABASE_URL") ? "listed" : "not in payload");
console.log("  SESSION_SECRET:", has("SESSION_SECRET") ? "listed" : "not in payload");
console.log("  WMS_AUTO_MIGRATE:", has("WMS_AUTO_MIGRATE") ? "listed" : "not in payload");
