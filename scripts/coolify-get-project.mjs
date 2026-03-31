import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dotenvPath = path.join(__dirname, "..", ".env.coolify.local");

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

const projectUuid = process.argv[2]?.trim();
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

if (!projectUuid) {
  console.error("Usage: node scripts/coolify-get-project.mjs <project-uuid>");
  console.error("List projects: node scripts/coolify-list-projects.mjs");
  process.exit(1);
}
if (!token || !base) {
  console.error("Need COOLIFY_API_TOKEN and COOLIFY_BASE_URL (or COOLIFY_DEPLOY_WEBHOOK_URL) in .env.coolify.local or env.");
  process.exit(1);
}

const res = await fetch(`${base}/projects/${projectUuid}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const j = await res.json();
console.log("status", res.status);
console.log(JSON.stringify(j, null, 2).slice(0, 12000));
