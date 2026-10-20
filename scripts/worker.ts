import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { executeLightspeedCatalogJob } from "@/lib/server/inventory-sync";
import { executeShopifyImageSyncJob } from "@/lib/server/shopify-catalog-images";
import { isLightspeedCatalogSyncEnabled } from "@/lib/server/lightspeed-sync-flag";
import { executeShopifyProductPush } from "@/lib/server/shopify-publish";
import { executeShopifyLinkAll } from "@/lib/server/shopify-link";
import { executeShopifyInventorySync } from "@/lib/server/shopify-inventory-sync";
import { executeShopifyTranslate } from "@/lib/server/shopify-translate";
import { executeShopifyAdsSync } from "@/lib/server/shopify-ads-sync";
import { signSession } from "@/lib/auth";
import { nightlySendDue } from "@/lib/server/studio-batch";
import { maybeRunShieldMaintenance } from "@/lib/server/shield/maintenance";

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
  "shopify_link_all",
  "shopify_inventory_sync",
  "shopify_translate",
  "shopify_ads_sync",
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

const INVENTORY_AUTOSYNC_INTERVAL_MS = 5 * 60 * 1000;
let lastInventoryAutoSyncAt: Date | null = null;

/**
 * Periodic Shopify inventory auto-sync: every ~5 min enqueue a DELTA inventory
 * sync (only variants whose WMS on-hand changed since last push) unless one is
 * already pending. WMS is the source of truth for quantities.
 */
async function maybeEnqueueInventoryAutoSync(pool: Pool): Promise<void> {
  const now = new Date();
  if (
    lastInventoryAutoSyncAt &&
    now.getTime() - lastInventoryAutoSyncAt.getTime() < INVENTORY_AUTOSYNC_INTERVAL_MS
  ) {
    return;
  }
  try {
    const active = await pool.query(
      `SELECT 1 FROM sync_jobs WHERE job_type = 'shopify_inventory_sync' AND status IN ('queued','running') LIMIT 1`,
    );
    if (active.rowCount === 0) {
      const seed = await pool.query<{ tenant_id: string; location_id: string }>(
        `SELECT tenant_id::text, location_id::text FROM sync_jobs ORDER BY created_at DESC LIMIT 1`,
      );
      const s = seed.rows[0];
      if (s) {
        await pool.query(
          `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
           VALUES ($1::uuid, $2::uuid, 'shopify_inventory_sync', 'queued', $3, '{"full":false,"trigger":"auto"}'::jsonb)`,
          [s.tenant_id, s.location_id, `shopify_inventory_sync:auto:${now.getTime()}`],
        );
      }
    }
    lastInventoryAutoSyncAt = now;
  } catch (e) {
    console.error("[worker] inventory auto-sync enqueue failed", e);
  }
}

const STUDIO_BATCH_TICK_MS = 5 * 60 * 1000;
/** A night whose send keeps failing stops retrying after this many tries. */
const STUDIO_BATCH_MAX_TRIES_PER_NIGHT = 3;
let lastStudioBatchTickAt: Date | null = null;

/**
 * Studio night batch (lib/server/studio-batch.ts). Every ~5 min: at 1–5 AM
 * Eastern send what is queued (once a night), and while a batch is with
 * OpenAI ask the web app to check on it. The OpenAI key lives only in the web
 * app, so the worker calls its /api/studio/batch/run (send) and /poll (check)
 * as the person who queued the latest run.
 */
async function maybeRunStudioBatch(pool: Pool): Promise<void> {
  const now = new Date();
  if (lastStudioBatchTickAt && now.getTime() - lastStudioBatchTickAt.getTime() < STUDIO_BATCH_TICK_MS) return;
  lastStudioBatchTickAt = now;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const r = await pool.query<{
      tenant_id: string;
      queued: number;
      has_open: boolean;
      sent_tonight: number;
      failed_tonight: number;
      added_by: string | null;
      added_email: string | null;
      added_role: string | null;
      location_id: string | null;
    }>(
      `WITH t AS (
         SELECT DISTINCT tenant_id FROM studio_batch_items WHERE status IN ('queued', 'submitted')
       ), today AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS d)
       SELECT t.tenant_id::text,
              (SELECT count(*) FROM studio_batch_items i WHERE i.tenant_id = t.tenant_id AND i.status = 'queued')::int AS queued,
              EXISTS (SELECT 1 FROM studio_batches b
                       WHERE b.tenant_id = t.tenant_id AND b.openai_batch_id IS NOT NULL
                         AND b.status IN ('submitted', 'validating', 'in_progress', 'finalizing', 'completed')) AS has_open,
              (SELECT count(*) FROM studio_batches b, today
                WHERE b.tenant_id = t.tenant_id AND b.trigger = 'nightly' AND b.status <> 'failed'
                  AND (b.created_at AT TIME ZONE 'America/New_York')::date = today.d)::int AS sent_tonight,
              (SELECT count(*) FROM studio_batches b, today
                WHERE b.tenant_id = t.tenant_id AND b.trigger = 'nightly' AND b.status = 'failed'
                  AND (b.created_at AT TIME ZONE 'America/New_York')::date = today.d)::int AS failed_tonight,
              a.added_by::text, a.added_email, a.added_role, a.location_id::text
         FROM t
         LEFT JOIN LATERAL (
           SELECT added_by, added_email, added_role, location_id FROM studio_batch_items i
            WHERE i.tenant_id = t.tenant_id AND i.added_by IS NOT NULL AND i.location_id IS NOT NULL
            ORDER BY i.added_at DESC LIMIT 1
         ) a ON true`,
    );
    const etHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now),
    );
    for (const t of r.rows) {
      if (!t.added_by || !t.location_id) continue;
      const sentTonight = t.sent_tonight > 0 || t.failed_tonight >= STUDIO_BATCH_MAX_TRIES_PER_NIGHT;
      const action = nightlySendDue(etHour, sentTonight, t.queued) ? "submit" : t.has_open ? "poll" : null;
      if (!action) continue;
      const token = await signSession({
        sub: t.added_by,
        email: t.added_email ?? "",
        tid: t.tenant_id,
        lid: t.location_id,
        role: t.added_role ?? "member",
      });
      const res = await fetch(`${base}/api/studio/batch/${action === "submit" ? "run" : "poll"}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "nightly" }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 202 && res.status !== 409) {
        console.error(`[worker] studio batch ${action} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      } else if (action === "submit") {
        console.log(`[worker] studio batch: nightly send started (${t.queued} queued run(s))`);
      }
    }
  } catch (e) {
    console.error("[worker] studio batch tick failed", e);
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
  if (job.job_type === "shopify_link_all") {
    await executeShopifyLinkAll(pool, job.id);
    /* Sets its own terminal status. */
    return;
  }
  if (job.job_type === "shopify_inventory_sync") {
    await executeShopifyInventorySync(pool, job.id);
    /* Sets its own terminal status. */
    return;
  }
  if (job.job_type === "shopify_translate") {
    await executeShopifyTranslate(pool, job.id);
    /* Sets its own terminal status + result (every change, before → after). */
    return;
  }
  if (job.job_type === "shopify_ads_sync") {
    await executeShopifyAdsSync(pool, job.id);
    /* Sets its own terminal status + per-group report. */
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
      await maybeEnqueueInventoryAutoSync(pool);
      await maybeRunStudioBatch(pool);
      await maybeRunShieldMaintenance(pool);
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
