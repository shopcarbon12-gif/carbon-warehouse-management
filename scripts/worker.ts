import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { executeLightspeedCatalogJob } from "@/lib/server/inventory-sync";
import { executeShopifyImageSyncJob } from "@/lib/server/shopify-catalog-images";
import { isLightspeedCatalogSyncEnabled } from "@/lib/server/lightspeed-sync-flag";
import { executeShopifyProductPush } from "@/lib/server/shopify-publish";

loadEnvConfig(process.cwd());

const rawDbUrl = process.env.DATABASE_URL?.trim();
if (!rawDbUrl) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const databaseUrl: string = rawDbUrl;

type JobRow = {
  id: string;
  job_type: string;
  tenant_id: string;
  location_id: string | null;
  attempts: number;
};

async function claimJob(pool: Pool): Promise<JobRow | null> {
  const rows = await pool.query<JobRow>(
    `UPDATE sync_jobs
     SET
       status = 'running',
       updated_at = now(),
       attempts = attempts + 1
     WHERE id = (
       SELECT id FROM sync_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, job_type, tenant_id, location_id, attempts`,
  );
  return rows.rows[0] ?? null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const CATALOG_SYNC_JOB_TYPES = new Set(["lightspeed_catalog", "lightspeed_pull"]);
// Job types whose executor sets its own terminal status/progress — the main
// loop must NOT slap a generic 'completed' over them.
const SELF_TERMINAL_JOB_TYPES = new Set([
  ...CATALOG_SYNC_JOB_TYPES,
  "shopify_image_sync",
  "shopify_product_push",
]);

const REPORT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastReportCleanupAt: Date | null = null;

/**
 * Daily-throttled retention cleanup for `inventory_reports` (1-year audit window).
 * Resets to `null` on worker boot; runs on first loop iteration after start.
 * Wrapped in try/catch so a failure (e.g. transient DB blip) cannot crash the worker.
 */
async function runReportRetentionCleanup(pool: Pool): Promise<void> {
  const now = new Date();
  if (
    lastReportCleanupAt &&
    now.getTime() - lastReportCleanupAt.getTime() < REPORT_CLEANUP_INTERVAL_MS
  ) {
    return;
  }
  try {
    const r = await pool.query(
      `DELETE FROM inventory_reports WHERE expires_at < now()`,
    );
    lastReportCleanupAt = now;
    console.log(
      `[worker] inventory_reports cleanup: rowsDeleted=${r.rowCount ?? 0}`,
    );
  } catch (e) {
    /* Don't update lastReportCleanupAt — let the next iteration retry. */
    console.error("[worker] inventory_reports cleanup failed", e);
  }
}

async function processStub(pool: Pool, job: JobRow): Promise<void> {
  if (CATALOG_SYNC_JOB_TYPES.has(job.job_type)) {
    // WMS is the catalog source of truth — Lightspeed pull retired as a source.
    // Any stale queued catalog job is skipped (not run) so it can't overwrite
    // WMS-authored fields. These job types are self-terminal, so set status here.
    if (!isLightspeedCatalogSyncEnabled()) {
      await pool.query(
        `UPDATE sync_jobs
            SET status = 'completed',
                progress_message = 'skipped: Lightspeed catalog sync disabled (WMS is source of truth)',
                finished_at = now()
          WHERE id = $1`,
        [job.id],
      );
      console.log(`[worker] catalog job ${job.id} skipped — LS sync disabled`);
      return;
    }
    await executeLightspeedCatalogJob(pool, job.id);
    /* Terminal status + payload are set inside the catalog sync (no generic completed UPDATE). */
    return;
  }
  if (job.job_type === "shopify_image_sync") {
    await executeShopifyImageSyncJob(pool, job.id);
    /* Sets its own terminal status + result payload. */
    return;
  }
  if (job.job_type === "shopify_product_push") {
    await executeShopifyProductPush(pool, job.id);
    /* Sets its own terminal status. */
    return;
  }
  // Stub: reconcile / future job types. Idempotency is enforced by idempotency_key on insert.
  await sleep(50 + Math.floor(Math.random() * 80));
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  console.log("WMS worker started (Ctrl+C to stop)");

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  while (running) {
    try {
      await runReportRetentionCleanup(pool);
      const job = await claimJob(pool);
      if (!job) {
        await sleep(800);
        continue;
      }
      try {
        await processStub(pool, job);
        if (!SELF_TERMINAL_JOB_TYPES.has(job.job_type)) {
          await pool.query(
            `UPDATE sync_jobs
             SET status = 'completed', error = NULL, updated_at = now()
             WHERE id = $1::uuid`,
            [job.id],
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await pool.query(
          `UPDATE sync_jobs
           SET status = 'failed', error = $1, updated_at = now()
           WHERE id = $2::uuid`,
          [msg, job.id],
        );
      }
    } catch (e) {
      console.error("[worker loop]", e);
      await sleep(2000);
    }
  }

  await pool.end();
  console.log("WMS worker stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
