/**
 * Ensures the WMS app has a Docker persistent volume for public uploads (OTA APKs, etc.).
 *
 * 1) Preferred: GET/POST /applications/{uuid}/storages (newer Coolify).
 * 2) Fallback: PATCH /applications/{uuid} with custom_docker_run_options `-v <name>:/app/public/uploads`
 *    when the storages API returns 404 (e.g. Coolify 4.0.0-beta.463).
 *
 * Loads .env.coolify.local (COOLIFY_API_TOKEN, COOLIFY_BASE_URL or COOLIFY_DEPLOY_WEBHOOK_URL,
 * application uuid from webhook ?uuid=).
 *
 * Usage:
 *   node scripts/coolify-ensure-uploads-volume.mjs
 *   node scripts/coolify-ensure-uploads-volume.mjs --no-redeploy
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { setTimeout as delay } from "node:timers/promises";

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

const noRedeploy = process.argv.includes("--no-redeploy");
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

const VOLUME_NAME = process.env.COOLIFY_UPLOADS_VOLUME_NAME?.trim() || "wms-public-uploads";
const MOUNT_PATH = process.env.COOLIFY_UPLOADS_MOUNT_PATH?.trim() || "/app/public/uploads";

if (!token || !base || !appUuid) {
  console.error(
    "Need COOLIFY_API_TOKEN, API base (COOLIFY_BASE_URL or COOLIFY_DEPLOY_WEBHOOK_URL), and app uuid (webhook ?uuid= or COOLIFY_APPLICATION_UUID).",
  );
  process.exit(1);
}

const authHeaders = { Authorization: `Bearer ${token}`, Accept: "application/json" };

function uploadsAlreadyMounted(data) {
  const arr = data?.persistent_storages ?? [];
  return arr.some((s) => {
    const mp = String(s.mount_path ?? s.mountPath ?? "");
    return mp === MOUNT_PATH || mp === `${MOUNT_PATH}/mobile-apk` || mp.startsWith(`${MOUNT_PATH}/`);
  });
}

/**
 * Coolify beta without /storages: inject `docker run` `-v` so uploads survive redeploys.
 * Merges with existing custom_docker_run_options (does not replace unrelated flags).
 * @returns {Promise<boolean>} true if application was PATCHed (redeploy recommended)
 */
async function ensureViaDockerRunOptions() {
  const appRes = await fetch(`${base}/applications/${appUuid}`, { headers: authHeaders });
  const appText = await appRes.text();
  let app;
  try {
    app = JSON.parse(appText);
  } catch {
    console.error("GET application: non-JSON", appRes.status, appText.slice(0, 400));
    process.exit(1);
  }
  if (!appRes.ok) {
    console.error("GET application failed:", appRes.status, appText.slice(0, 600));
    process.exit(1);
  }

  const existing = String(app.custom_docker_run_options ?? "").trim();
  if (existing.includes(MOUNT_PATH)) {
    console.log("custom_docker_run_options already references", MOUNT_PATH + "; skipping patch.");
    return false;
  }

  const volFlag = `-v ${VOLUME_NAME}:${MOUNT_PATH}`;
  const merged = existing ? `${existing} ${volFlag}` : volFlag;

  const patchRes = await fetch(`${base}/applications/${appUuid}`, {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ custom_docker_run_options: merged }),
  });
  const patchText = await patchRes.text();
  if (!patchRes.ok) {
    console.error("PATCH custom_docker_run_options failed:", patchRes.status, patchText.slice(0, 800));
    console.error(
      "Fallback: Coolify UI → Application → Configuration → add Persistent Storage →",
      MOUNT_PATH,
    );
    process.exit(1);
  }
  console.log(
    "Storages API unavailable — set custom_docker_run_options (named Docker volume for uploads):",
    merged,
  );
  return true;
}

function triggerDeploy() {
  console.log("Triggering deploy…");
  execSync("node scripts/trigger-coolify-deploy.mjs", { cwd: root, stdio: "inherit" });
}

const listRes = await fetch(`${base}/applications/${appUuid}/storages`, {
  headers: authHeaders,
});
const listText = await listRes.text();
let listData;
try {
  listData = JSON.parse(listText);
} catch {
  console.error("List storages: non-JSON", listRes.status, listText.slice(0, 400));
  process.exit(1);
}

if (!listRes.ok && listRes.status === 404) {
  let ver = "";
  try {
    const vr = await fetch(`${base}/version`, { headers: authHeaders });
    if (vr.ok) ver = (await vr.text()).trim().slice(0, 80);
  } catch {
    /* ignore */
  }
  console.warn(
    "GET /applications/{uuid}/storages → 404",
    ver ? `(${ver})` : "",
    "— using custom_docker_run_options fallback.",
  );
  const patched = await ensureViaDockerRunOptions();
  const force = process.env.COOLIFY_UPLOADS_FORCE_REDEPLOY === "1";
  if (!noRedeploy && (patched || force)) {
    triggerDeploy();
  } else if (!noRedeploy && !patched) {
    console.log(
      "No PATCH needed (volume flag already in custom_docker_run_options). If the running container predates this, run: npm run deploy:coolify",
    );
  } else console.log("Skipped redeploy (--no-redeploy).");
  await delay(50);
  process.exit(0);
}

if (!listRes.ok) {
  console.error("List storages failed:", listRes.status, listText.slice(0, 600));
  process.exit(1);
}

if (uploadsAlreadyMounted(listData)) {
  console.log("Persistent mount under", MOUNT_PATH, "already present; skipping create.");
} else {
  const body = {
    type: "persistent",
    name: VOLUME_NAME,
    mount_path: MOUNT_PATH,
  };
  const createRes = await fetch(`${base}/applications/${appUuid}/storages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const createText = await createRes.text();
  if (!createRes.ok) {
    console.error("Create storage failed:", createRes.status, createText.slice(0, 800));
    process.exit(1);
  }
  console.log("Created persistent storage:", VOLUME_NAME, "→", MOUNT_PATH, createText ? createText.slice(0, 200) : "");
}

if (!noRedeploy) triggerDeploy();
else console.log("Skipped redeploy (--no-redeploy). Redeploy in Coolify when ready.");
