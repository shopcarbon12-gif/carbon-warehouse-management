/**
 * One-off helper: GET /applications/{uuid} and print top-level keys (no secrets logged).
 * Loads COOLIFY_API_TOKEN + base URL from .env.coolify.local.
 * Usage: node scripts/coolify-get-application-json.mjs [uuid]
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

const uuid =
  process.argv[2]?.trim() ||
  (() => {
    const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
    const m = u.match(/[?&]uuid=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  })();

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

if (!uuid || !token || !base) {
  console.error("Need uuid arg or webhook uuid=, COOLIFY_API_TOKEN, and base URL.");
  process.exit(1);
}

const res = await fetch(`${base}/applications/${uuid}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error(res.status, text.slice(0, 500));
  process.exit(1);
}

if (!res.ok) {
  console.error(res.status, JSON.stringify(data).slice(0, 800));
  process.exit(1);
}

console.log("Top-level keys:", Object.keys(data).sort().join(", "));
if (data.destination && typeof data.destination === "object") {
  console.log("\ndestination keys:", Object.keys(data.destination).sort().join(", "));
  for (const k of Object.keys(data.destination)) {
    if (/storage|volume|mount|persistent/i.test(k)) {
      console.log(`destination.${k}:`, JSON.stringify(data.destination[k]).slice(0, 800));
    }
  }
}
for (const k of Object.keys(data).sort()) {
  if (/storage|volume|mount|persistent|docker/i.test(k)) {
    const v = data[k];
    const s = typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v)?.slice(0, 400);
    console.log(`\n[${k}]:`, s);
  }
}
