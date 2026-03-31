/**
 * Ensures the WMS app has a Docker persistent volume for public uploads (OTA APKs, etc.).
 * Uses Coolify API: GET/POST /applications/{uuid}/storages (OpenAPI).
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

function uploadsAlreadyMounted(data) {
  const arr = data?.persistent_storages ?? [];
  return arr.some((s) => {
    const mp = String(s.mount_path ?? s.mountPath ?? "");
    return mp === MOUNT_PATH || mp === `${MOUNT_PATH}/mobile-apk` || mp.startsWith(`${MOUNT_PATH}/`);
  });
}

const listRes = await fetch(`${base}/applications/${appUuid}/storages`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
});
const listText = await listRes.text();
let listData;
try {
  listData = JSON.parse(listText);
} catch {
  console.error("List storages: non-JSON", listRes.status, listText.slice(0, 400));
  process.exit(1);
}
if (!listRes.ok) {
  if (listRes.status === 404) {
    let ver = "";
    try {
      const vr = await fetch(`${base}/version`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (vr.ok) ver = (await vr.text()).trim().slice(0, 80);
    } catch {
      /* ignore */
    }
    console.error(
      "GET /applications/{uuid}/storages returned 404. This Coolify build",
      ver ? `(${ver}) ` : "",
      "likely predates the storage API (newer 4.0 betas add POST/GET .../storages).",
    );
    console.error(
      "Fix: upgrade Coolify, then run: node scripts/coolify-ensure-uploads-volume.mjs",
    );
    console.error(
      "Or add the volume in the UI: Configuration → Persistent Storage → + Add → Volume / Volume mount.",
      "Destination: /app/public/uploads. Then Redeploy.",
    );
    console.error("Docs: https://coolify.io/docs/knowledge-base/persistent-storage");
    await delay(150);
    process.exit(3);
  } else {
    console.error("List storages failed:", listRes.status, listText.slice(0, 600));
    process.exit(1);
  }
} else {
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

  if (!noRedeploy) {
    console.log("Triggering deploy…");
    execSync("node scripts/trigger-coolify-deploy.mjs", { cwd: root, stdio: "inherit" });
  } else {
    console.log("Skipped redeploy (--no-redeploy). Redeploy in Coolify when ready.");
  }
}
