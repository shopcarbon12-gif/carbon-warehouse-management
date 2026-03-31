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

if (!token || !base) {
  console.error("Need COOLIFY_API_TOKEN and COOLIFY_BASE_URL (or COOLIFY_DEPLOY_WEBHOOK_URL) in .env.coolify.local or env.");
  process.exit(1);
}

const res = await fetch(`${base}/projects`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const text = await res.text();
let j;
try {
  j = JSON.parse(text);
} catch {
  console.error(res.status, text.slice(0, 400));
  process.exit(1);
}
const list = Array.isArray(j) ? j : j?.data ?? [];
console.log("status", res.status, "count", list.length);
for (const p of list) {
  console.log(p.name, p.uuid);
}
