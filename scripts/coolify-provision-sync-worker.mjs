/**
 * Create (or update env + deploy) a Coolify application that runs `npm run worker` via Dockerfile.worker.
 *
 * Prerequisites:
 * - .env.coolify.local: COOLIFY_API_TOKEN (must allow application create + env PATCH + deploy, not deploy-only)
 * - COOLIFY_DEPLOY_WEBHOOK_URL with uuid= of the **existing WMS web** application
 *
 * Idempotency:
 * - Set COOLIFY_WORKER_APP_UUID in .env.coolify.local after first run to skip POST create (only sync env + deploy).
 *
 * Usage:
 *   node scripts/coolify-provision-sync-worker.mjs
 *   node scripts/coolify-provision-sync-worker.mjs --dry-run
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

const dryRun = process.argv.includes("--dry-run");

function apiBase() {
  const b = process.env.COOLIFY_BASE_URL?.trim();
  if (b) return b.replace(/\/$/, "");
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  try {
    const { protocol, host } = new URL(u);
    return `${protocol}//${host}/api/v1`;
  } catch {
    return "";
  }
}

function webAppUuid() {
  const fromEnv = process.env.COOLIFY_WORKER_WEB_APP_UUID?.trim();
  if (fromEnv) return fromEnv;
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  const m = u.match(/[?&]uuid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const base = apiBase();
const token = process.env.COOLIFY_API_TOKEN?.trim();
const webUuid = webAppUuid();
let workerUuid = process.env.COOLIFY_WORKER_APP_UUID?.trim() || "";

if (!base || !token || !webUuid) {
  console.error(
    "Need COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL (web app uuid=), optional COOLIFY_BASE_URL in .env.coolify.local",
  );
  process.exit(1);
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

/** Dedupe env keys: prefer runtime row over buildtime duplicate. */
function mergeWebEnvs(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.key;
    if (!key) continue;
    const prev = map.get(key);
    const score = row.is_runtime ? 2 : row.is_buildtime ? 1 : 0;
    const prevScore = prev
      ? prev.is_runtime
        ? 2
        : prev.is_buildtime
          ? 1
          : 0
      : -1;
    if (!prev || score >= prevScore) {
      map.set(key, row);
    }
  }
  return [...map.values()];
}

function envRowToBulk(row) {
  const v = row.real_value ?? row.value ?? "";
  const unquoted =
    typeof v === "string" && v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
      ? v.slice(1, -1)
      : String(v);
  return {
    key: row.key,
    value: unquoted,
    is_literal: true,
    is_multiline: false,
  };
}

async function getPrivateKeyUuidForApp(privateKeyId) {
  const { res, data } = await fetchJson("/security/keys");
  if (!res.ok) {
    console.error("Failed to list security keys:", res.status, data);
    process.exit(1);
  }
  const arr = Array.isArray(data) ? data : [];
  const row = arr.find((k) => k.id === privateKeyId);
  return row?.uuid ?? "";
}

async function resolveProjectForEnvironment(environmentId) {
  const { res, data } = await fetchJson("/projects");
  if (!res.ok) {
    console.error("Failed to list projects:", res.status, data);
    process.exit(1);
  }
  const list = Array.isArray(data) ? data : data?.data ?? [];
  for (const p of list) {
    const { res: r2, data: det } = await fetchJson(`/projects/${p.uuid}`);
    if (!r2.ok) continue;
    const envs = det.environments || [];
    const hit = envs.find((e) => e.id === environmentId);
    if (hit) {
      return { projectUuid: p.uuid, environmentName: hit.name || "production" };
    }
  }
  return null;
}

async function main() {
  const { res: wRes, data: webApp } = await fetchJson(`/applications/${webUuid}`);
  if (!wRes.ok) {
    console.error("Failed to GET web application:", wRes.status, webApp);
    process.exit(1);
  }

  const serverUuid = webApp.destination?.server?.uuid;
  const destinationUuid = webApp.destination?.uuid;
  const privateKeyId = webApp.private_key_id;
  const envId = webApp.environment_id;

  const resolved =
    process.env.COOLIFY_PROJECT_UUID?.trim() && process.env.COOLIFY_ENVIRONMENT_NAME?.trim()
      ? {
          projectUuid: process.env.COOLIFY_PROJECT_UUID.trim(),
          environmentName: process.env.COOLIFY_ENVIRONMENT_NAME.trim(),
        }
      : await resolveProjectForEnvironment(envId);

  const projectUuid = resolved?.projectUuid;
  const envName = resolved?.environmentName || "production";

  if (!projectUuid || !serverUuid || !destinationUuid) {
    console.error(
      "Could not resolve project/server/destination. Set COOLIFY_PROJECT_UUID + COOLIFY_ENVIRONMENT_NAME in .env.coolify.local or fix API access.",
      { projectUuid, serverUuid, destinationUuid },
    );
    process.exit(1);
  }

  const privateKeyUuid = await getPrivateKeyUuidForApp(privateKeyId);
  if (!privateKeyUuid) {
    console.error("Could not resolve private_key_uuid for private_key_id", privateKeyId);
    process.exit(1);
  }

  if (!workerUuid) {
    const body = {
      project_uuid: projectUuid,
      server_uuid: serverUuid,
      environment_name: envName,
      private_key_uuid: privateKeyUuid,
      git_repository: webApp.git_repository,
      git_branch: webApp.git_branch || "main",
      ports_exposes: "3000",
      destination_uuid: destinationUuid,
      build_pack: "dockerfile",
      dockerfile_location: "/Dockerfile.worker",
      name: "carbon-wms-sync-worker",
      description: "WMS sync_jobs worker (Lightspeed catalog queue); no public URL",
      domains: "",
      git_commit_sha: "HEAD",
      is_auto_deploy_enabled: true,
      is_static: false,
      is_spa: false,
      health_check_enabled: false,
      instant_deploy: false,
    };

    if (dryRun) {
      console.log("DRY RUN: would POST /applications/private-deploy-key with dockerfile Dockerfile.worker");
      console.log(JSON.stringify({ ...body, private_key_uuid: "(redacted)" }, null, 2));
      process.exit(0);
    }

    const { res: cRes, data: created } = await fetchJson("/applications/private-deploy-key", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (cRes.status === 409) {
      const { res: lRes, data: list } = await fetchJson("/applications");
      if (!lRes.ok || !Array.isArray(list)) {
        console.error("Create 409 and could not list applications:", lRes.status, list);
        process.exit(1);
      }
      const existing = list.find((a) => a.name === "carbon-wms-sync-worker");
      if (!existing?.uuid) {
        console.error("Create 409 — rename conflict? Response:", created);
        process.exit(1);
      }
      workerUuid = existing.uuid;
      console.log("Worker app already exists, using uuid:", workerUuid);
    } else if (!cRes.ok) {
      console.error("Create failed:", cRes.status, created);
      process.exit(1);
    } else {
      workerUuid = created?.uuid || "";
      if (!workerUuid) {
        console.error("Create response missing uuid:", created);
        process.exit(1);
      }
      console.log("Created worker application uuid:", workerUuid);
    }
    console.log("Add to .env.coolify.local: COOLIFY_WORKER_APP_UUID=" + workerUuid);
  } else {
    console.log("Using existing COOLIFY_WORKER_APP_UUID:", workerUuid);
  }

  const { res: eRes, data: envRows } = await fetchJson(`/applications/${webUuid}/envs`);
  if (!eRes.ok) {
    console.error("Failed to GET web envs:", eRes.status, envRows);
    process.exit(1);
  }

  const merged = mergeWebEnvs(Array.isArray(envRows) ? envRows : []);
  const bulk = merged.map(envRowToBulk);

  /** Worker container: no Next server; migrations belong on web deploy */
  for (let i = 0; i < bulk.length; i++) {
    if (bulk[i].key === "WMS_AUTO_MIGRATE") {
      bulk[i] = { ...bulk[i], value: "0" };
    }
  }

  if (dryRun) {
    console.log("DRY RUN: would PATCH", bulk.length, "env vars to worker (WMS_AUTO_MIGRATE forced to 0)");
    process.exit(0);
  }

  const { res: pRes, data: patchOut } = await fetchJson(`/applications/${workerUuid}/envs/bulk`, {
    method: "PATCH",
    body: JSON.stringify({ data: bulk }),
  });

  if (!pRes.ok) {
    console.error("Env bulk PATCH failed:", pRes.status, patchOut);
    process.exit(1);
  }

  console.log("Synced", bulk.length, "environment variables from web app (WMS_AUTO_MIGRATE=0 for worker).");

  const deployPath = `/deploy?uuid=${encodeURIComponent(workerUuid)}&force=false`;
  const { res: dRes, data: depOut } = await fetchJson(deployPath, { method: "POST" });

  if (!dRes.ok) {
    console.error("Deploy trigger failed:", dRes.status, depOut);
    console.error(
      "Open Coolify → carbon-wms-sync-worker → Deploy, or set COOLIFY_WORKER_DEPLOY_WEBHOOK_URL and run npm run deploy:coolify:worker",
    );
    process.exit(1);
  }

  console.log("Deploy queued for worker app. Watch Coolify → carbon-wms-sync-worker → Logs (expect: WMS worker started).");
  const workerWebhook = `${base}/deploy?uuid=${encodeURIComponent(workerUuid)}&force=false`;
  console.log("Optional — add to .env.coolify.local for worker-only deploys:");
  console.log("COOLIFY_WORKER_DEPLOY_WEBHOOK_URL=" + workerWebhook);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
