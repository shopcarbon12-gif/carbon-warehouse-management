/**
 * End-to-end: ensure WMS_OPS_SMOKE_SECRET on Coolify web app (optional PATCH), redeploy if changed,
 * poll until deploy finishes, GET /api/health + /api/health/ready, POST internal smoke reconcile job,
 * poll until worker marks job completed.
 *
 * Loads .env.coolify.local: COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL,
 * WMS_APP_PUBLIC_BASE_URL (or NEXT_PUBLIC_BASE_URL), optional WMS_OPS_SMOKE_SECRET (generated if missing).
 *
 * Usage: node scripts/wms-production-verify-and-smoke.mjs
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
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
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL || "";
  const m = u.match(/[?&]uuid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function unquoteEnv(val) {
  if (val == null) return "";
  const v = String(val).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Coolify often omits or masks secrets in GET /envs — do not PATCH every run based on "***". */
function looksMaskedOrUnknown(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return true;
  if (/^[*•●]+$/.test(t)) return true;
  return false;
}

/** Match server route: one layer of outer quotes removed so x-wms-smoke-secret matches container. */
function normalizeSmokeSecret(raw) {
  let s = unquoteEnv(raw).trim();
  if (
    s.length >= 2 &&
    ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}


const base = apiBase();
const token = process.env.COOLIFY_API_TOKEN?.trim();
const webUuid = webAppUuid();
const publicBase = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");

if (!base || !token || !webUuid || !publicBase) {
  console.error(
    "Need COOLIFY_API_TOKEN, COOLIFY_DEPLOY_WEBHOOK_URL, WMS_APP_PUBLIC_BASE_URL (or NEXT_PUBLIC_BASE_URL) in .env.coolify.local",
  );
  process.exit(1);
}

const hJson = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...hJson, ...opts.headers } });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

function deploymentList(data) {
  return Array.isArray(data) ? data : data?.deployments ?? data?.data ?? [];
}

function newestStatus(list) {
  const top = list[0];
  if (!top) return { status: "empty", commit: "" };
  return { status: String(top.status || ""), commit: String(top.commit || "").slice(0, 7) };
}

async function pollAppDeployments(label, uuid, untilClean, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { res, data } = await fetchJson(`${base}/deployments/applications/${uuid}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(label, "deploy list failed", res.status, data);
      await delay(8000);
      continue;
    }
    const list = deploymentList(data);
    const { status, commit } = newestStatus(list);
    const inProg = list.find((d) => String(d.status).toLowerCase() === "in_progress");
    const queued = list.find((d) => String(d.status).toLowerCase() === "queued");
    console.log(`[${label}] top=${status} commit=${commit} in_progress=${Boolean(inProg)} queued=${Boolean(queued)}`);
    if (untilClean(list)) {
      return { ok: true, list };
    }
    await delay(8000);
  }
  return { ok: false };
}

async function triggerWebDeploy() {
  const u = process.env.COOLIFY_DEPLOY_WEBHOOK_URL?.trim();
  if (!u) return false;
  const res = await fetch(u, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const t = await res.text();
  console.log("Trigger web deploy:", res.status, t.slice(0, 200));
  return res.ok;
}

async function triggerWorkerDeploy() {
  const u = process.env.COOLIFY_WORKER_DEPLOY_WEBHOOK_URL?.trim();
  if (!u) return false;
  const res = await fetch(u, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const t = await res.text();
  console.log("Trigger worker deploy:", res.status, t.slice(0, 200));
  return res.ok;
}

async function getWebEnvs() {
  const { res, data } = await fetchJson(`${base}/applications/${webUuid}/envs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, rows: [] };
  return { ok: true, rows: Array.isArray(data) ? data : [] };
}

/** When Coolify returns real_value (not masked), use it for HTTP — matches runtime after redeploy. */
async function readSmokeSecretFromCoolifyApi() {
  const envs = await getWebEnvs();
  if (!envs.ok) return null;
  const row = envs.rows.find((r) => r.key === "WMS_OPS_SMOKE_SECRET");
  const raw = row?.real_value ?? row?.value ?? "";
  if (looksMaskedOrUnknown(raw)) return null;
  const n = normalizeSmokeSecret(raw);
  return n || null;
}

async function patchSmokeSecret(secretValue) {
  const bulk = [
    {
      key: "WMS_OPS_SMOKE_SECRET",
      value: secretValue,
      is_literal: true,
      is_multiline: false,
    },
  ];
  const { res, data } = await fetchJson(`${base}/applications/${webUuid}/envs/bulk`, {
    method: "PATCH",
    body: JSON.stringify({ data: bulk }),
  });
  console.log("PATCH WMS_OPS_SMOKE_SECRET:", res.status, typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300));
  let effectiveHint = null;
  if (res.ok && Array.isArray(data) && data[0]) {
    const raw = data[0].real_value ?? data[0].value ?? "";
    if (!looksMaskedOrUnknown(raw)) {
      effectiveHint = normalizeSmokeSecret(raw);
    }
  }
  return { ok: res.ok, effectiveHint };
}

async function main() {
  const envs = await getWebEnvs();
  if (!envs.ok) {
    console.error("Could not read web app envs from Coolify");
    process.exit(1);
  }

  const fromApi0 = await readSmokeSecretFromCoolifyApi();
  let smokeSecret = process.env.WMS_OPS_SMOKE_SECRET?.trim() || fromApi0 || "";

  const existing = envs.rows.find((r) => r.key === "WMS_OPS_SMOKE_SECRET");
  const rawCurrent = existing?.real_value ?? existing?.value ?? "";
  const valueMasked = Boolean(existing && looksMaskedOrUnknown(rawCurrent));
  const currentNorm = existing && !valueMasked ? normalizeSmokeSecret(rawCurrent) : "";

  let needsPatch = false;
  if (!existing) {
    needsPatch = true;
    if (!smokeSecret) {
      smokeSecret = crypto.randomBytes(32).toString("hex");
      console.log("Generated WMS_OPS_SMOKE_SECRET (add to .env.coolify.local to reuse):");
      console.log("WMS_OPS_SMOKE_SECRET=" + smokeSecret);
    }
  } else if (!valueMasked && currentNorm) {
    if (!smokeSecret) {
      smokeSecret = currentNorm;
      console.log(
        "Using WMS_OPS_SMOKE_SECRET from Coolify (add to .env.coolify.local to reuse for masked API responses):",
      );
      console.log("WMS_OPS_SMOKE_SECRET=" + smokeSecret);
    } else if (currentNorm !== smokeSecret) {
      needsPatch = true;
    }
  } else if (valueMasked && !smokeSecret) {
    console.error(
      "Coolify has WMS_OPS_SMOKE_SECRET but the API masks the value. Add WMS_OPS_SMOKE_SECRET to .env.coolify.local (same string as in Coolify), then re-run.",
    );
    process.exit(1);
  }

  if (!smokeSecret) {
    console.error("WMS_OPS_SMOKE_SECRET is required (file, Coolify API real_value, or first-run generate).");
    process.exit(1);
  }

  if (needsPatch) {
    console.log("Coolify WMS_OPS_SMOKE_SECRET differs or missing — PATCH + redeploy web.");
    const patchOut = await patchSmokeSecret(smokeSecret);
    if (!patchOut.ok) process.exit(1);
    if (patchOut.effectiveHint) smokeSecret = patchOut.effectiveHint;
    if (!(await triggerWebDeploy())) process.exit(1);
    const webPoll = await pollAppDeployments(
      "web",
      webUuid,
      (list) => {
        const top = list[0];
        if (!top) return false;
        const st = String(top.status).toLowerCase();
        return st === "finished" || st === "failed";
      },
      900_000,
    );
    if (!webPoll.ok) {
      console.error("Web deploy poll timeout");
      process.exit(1);
    }
    const top = webPoll.list[0];
    if (String(top?.status).toLowerCase() === "failed") {
      console.error("Web deploy failed on Coolify");
      process.exit(1);
    }
  } else {
    console.log(
      valueMasked
        ? "WMS_OPS_SMOKE_SECRET present on Coolify (masked in GET /envs) — skip PATCH."
        : "WMS_OPS_SMOKE_SECRET already matches Coolify — skip PATCH/redeploy.",
    );
  }

  const fromApi = await readSmokeSecretFromCoolifyApi();
  if (fromApi) {
    smokeSecret = fromApi;
    console.log("Smoke header secret: synced from Coolify GET /envs (real_value).");
  }

  const health = await fetch(`${publicBase}/api/health`);
  const ht = await health.text();
  console.log("/api/health", health.status, ht.slice(0, 120));
  if (!health.ok) process.exit(1);

  const ready = await fetch(`${publicBase}/api/health/ready`);
  const rt = await ready.text();
  console.log("/api/health/ready", ready.status, rt.slice(0, 200));

  const smokeUrl = `${publicBase}/api/internal/smoke/worker-queue`;
  const postRes = await fetch(smokeUrl, {
    method: "POST",
    headers: {
      "x-wms-smoke-secret": smokeSecret,
      Accept: "application/json",
    },
  });
  const postJson = await postRes.json().catch(() => ({}));
  console.log("POST smoke", postRes.status, JSON.stringify(postJson).slice(0, 300));
  if (postRes.status === 404) {
    console.error("Smoke route 404 — container may not have WMS_OPS_SMOKE_SECRET yet. Redeploy web from Coolify.");
    process.exit(1);
  }
  if (!postRes.ok || !postJson.idempotency_key) {
    console.error("Smoke POST failed");
    process.exit(1);
  }

  const key = postJson.idempotency_key;
  const pollMs = Math.max(30_000, Number(process.env.WMS_SMOKE_POLL_MS ?? 120_000) || 120_000);
  const deadline = Date.now() + pollMs;
  while (Date.now() < deadline) {
    const gr = await fetch(`${smokeUrl}?idempotency_key=${encodeURIComponent(key)}`, {
      headers: { "x-wms-smoke-secret": smokeSecret, Accept: "application/json" },
    });
    const gj = await gr.json().catch(() => ({}));
    if (gr.ok && gj.status === "completed") {
      console.log("OK: worker completed stub reconcile job:", gj);
      console.log("\nAll checks passed.");
      process.exit(0);
    }
    if (gr.ok && gj.status === "failed") {
      console.error("Job failed:", gj);
      process.exit(1);
    }
    console.log("poll job", gr.status, gj.status || gj.error || "");
    await delay(2000);
  }

  console.error("Timeout waiting for job completed — is carbon-wms-sync-worker running?");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
