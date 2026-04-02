/**
 * Inserts a harmless queued `reconcile` job; the worker should claim it and mark completed (stub path).
 * Uses DATABASE_URL from .env.coolify.local (production). Does not call Lightspeed.
 *
 * Usage: node scripts/smoke-test-worker-queue.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
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

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl || !databaseUrl.startsWith("postgresql")) {
  console.error("Need DATABASE_URL (postgresql://…) in .env.coolify.local");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const idempotencyKey = `smoke-reconcile-${Date.now()}`;

try {
  const loc = await pool.query(
    `SELECT l.id AS location_id, l.tenant_id
     FROM locations l
     LIMIT 1`,
  );
  const row = loc.rows[0];
  if (!row) {
    console.error("No active location found — cannot insert sync_job.");
    process.exit(1);
  }

  const ins = await pool.query(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, 'reconcile', 'queued', $3, $4::jsonb)
     RETURNING id::text`,
    [row.tenant_id, row.location_id, idempotencyKey, JSON.stringify({ source: "smoke-test-worker-queue.mjs" })],
  );
  const jobId = ins.rows[0]?.id;
  console.log("Inserted queued reconcile job:", jobId, "idempotency:", idempotencyKey);

  const deadline = Date.now() + 60_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const st = await pool.query(`SELECT status, error, attempts FROM sync_jobs WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    const s = st.rows[0];
    lastStatus = s?.status ?? "";
    if (lastStatus === "completed") {
      console.log("OK: worker processed job → status=completed, attempts=", s.attempts);
      process.exit(0);
    }
    if (lastStatus === "failed") {
      console.error("FAIL: job failed:", s.error);
      process.exit(1);
    }
    await delay(1500);
  }

  console.error("TIMEOUT: last status=", lastStatus, "— is carbon-wms-sync-worker running in Coolify?");
  process.exit(2);
} finally {
  await pool.end();
}
