import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dotenvPath = path.join(root, ".env.coolify.local");
if (fs.existsSync(dotenvPath)) {
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
const res = await fetch(`${base}/databases`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const j = await res.json();
const list = Array.isArray(j) ? j : j?.data ?? [];
for (const d of list) {
  const typ = (d.type ?? d.database_type ?? "").toString();
  if (!typ.toLowerCase().includes("postgres")) continue;
  console.log(d.name ?? "(no name)", d.uuid, "env_id?", d.environment_id, "updated", d.updated_at);
}
