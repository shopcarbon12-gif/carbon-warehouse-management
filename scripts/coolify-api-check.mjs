/**
 * Verifies Coolify API v1 access using the same env as other Coolify scripts.
 *
 * Docs: https://coolify.io/docs/api-reference/authorization
 *       https://coolify.io/docs/api-reference/api/operations/get-application-by-uuid
 *
 * GET /applications/{uuid} needs a token that can read applications (not deploy-only).
 * PATCH /applications/{uuid}/envs/bulk needs permission to modify resources (use full * in UI
 * if your instance labels it that way; read-only / read:sensitive cannot update).
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
  console.error(
    "Need COOLIFY_BASE_URL (or COOLIFY_DEPLOY_WEBHOOK_URL), COOLIFY_API_TOKEN, and app uuid (COOLIFY_APP_UUID or uuid in webhook URL).",
  );
  process.exit(1);
}

const url = `${base}/applications/${appUuid}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});

const text = await res.text();
let summary = text.slice(0, 400);
try {
  const j = JSON.parse(text);
  if (j?.message) summary = j.message;
  if (res.ok && j?.uuid) {
    summary = `ok — name: ${j.name ?? "(none)"}, uuid: ${j.uuid}`;
  }
} catch {
  /* keep raw slice */
}

console.log(`GET ${url}`);
console.log(res.status, res.statusText, summary);

if (res.status === 403) {
  console.error(
    "\n403: token cannot read this application. Coolify docs list permissions such as read-only, read:sensitive, view:sensitive, and * (full).\n" +
      "Deploy-only tokens often cannot call GET /applications/{uuid}. Create a token with read + write (or *) for npm run coolify:set-db.\n" +
      "See: https://coolify.io/docs/api-reference/authorization",
  );
}
if (res.status === 401) {
  console.error("\n401: invalid or missing Bearer token.");
}

process.exit(res.ok ? 0 : 1);
