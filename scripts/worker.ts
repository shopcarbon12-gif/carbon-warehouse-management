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
import { executeSeoFull, maybeRunSeoWatch, SEO_FULL_JOB } from "@/lib/server/seo-full";
import { signSession } from "@/lib/auth";
import { nightlySendDue } from "@/lib/server/studio-batch";
import { maybeRunShieldMaintenance } from "@/lib/server/shield/maintenance";
import { maybeRunMetaFeed } from "@/lib/server/meta-feed";
import { maybeRunMarketing } from "@/lib/server/marketing/scheduler";
import { marketingAiPending } from "@/lib/server/marketing/ai-changes";
import { aiJobsPending } from "@/lib/server/marketing/ai-jobs";
import { emailWorkPending } from "@/lib/server/email/pending";
import { pendingTenants as creativePending } from "@/lib/server/creative/jobs";
import { runOneRender } from "@/lib/server/creative/render-worker";

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
  SEO_FULL_JOB,
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
    // A run cut off by a worker restart stays 'running' forever and blocked every
    // later sync (2026-10-26 → 10-29: no stock reached Shopify for 3 days). A run
    // that has not reported progress for 20 minutes is dead — close it.
    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', finished_at = now(),
              progress_message = COALESCE(progress_message || ' — ', '') || 'stalled (no progress for 20 min, worker restarted?)'
        WHERE job_type = 'shopify_inventory_sync' AND status = 'running' AND updated_at < now() - interval '20 minutes'`,
    );
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
         -- A batch whose every run was stopped still needs its checks (OpenAI's
         -- cancel finishes later; then its files are deleted).
         UNION
         SELECT DISTINCT tenant_id FROM studio_batches
          WHERE openai_batch_id IS NOT NULL
            AND status IN ('submitted', 'validating', 'in_progress', 'finalizing', 'cancelling', 'completed')
       ), today AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS d)
       SELECT t.tenant_id::text,
              (SELECT count(*) FROM studio_batch_items i WHERE i.tenant_id = t.tenant_id AND i.status = 'queued')::int AS queued,
              EXISTS (SELECT 1 FROM studio_batches b
                       WHERE b.tenant_id = t.tenant_id AND b.openai_batch_id IS NOT NULL
                         AND b.status IN ('submitted', 'validating', 'in_progress', 'finalizing', 'cancelling', 'completed')) AS has_open,
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

const GRADING_AI_TICK_MS = 60 * 1000;
let lastGradingAiTickAt: Date | null = null;

/**
 * CarbonGradingAI's AI batch (lib/server/grading-app-batch.ts): every minute
 * while a scan's AI jobs are open, ask the web app (which holds the OpenAI
 * key) to store answers and send the next rounds — as the person who saved
 * the scan.
 */
async function maybeRunGradingAi(pool: Pool): Promise<void> {
  const now = new Date();
  if (lastGradingAiTickAt && now.getTime() - lastGradingAiTickAt.getTime() < GRADING_AI_TICK_MS) return;
  lastGradingAiTickAt = now;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const r = await pool.query<{ tenant_id: string; user_id: string; email: string; role: string; location_id: string | null }>(
      `SELECT j.tenant_id::text, u.id::text AS user_id, u.email, m.role,
              (SELECT l.id::text FROM locations l WHERE l.tenant_id = j.tenant_id ORDER BY l.created_at LIMIT 1) AS location_id
         FROM grading_ai_jobs j
         JOIN users u ON u.id = j.created_by
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = j.tenant_id
        WHERE j.status IN ('waiting', 'sent')
        ORDER BY j.created_at DESC LIMIT 1`,
    ).catch(() => null);
    const t = r?.rows[0];
    if (!t || !t.location_id) return;
    const token = await signSession({ sub: t.user_id, email: t.email, tid: t.tenant_id, lid: t.location_id, role: t.role });
    const res = await fetch(`${base}/api/grading-app/ai-batch/tick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 202) console.error(`[worker] grading AI tick → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  } catch (e) {
    console.error("[worker] grading AI tick failed", e);
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
  if (job.job_type === SEO_FULL_JOB) {
    await executeSeoFull(pool, job.id);
    /* Sets its own terminal status + the seo_full_runs row. */
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

const SOCIAL_AI_TICK_MS = 60_000;
let lastSocialAiTickAt = 0;

/**
 * Social "Ask for changes" (lib/server/marketing/ai-changes.ts): while a note
 * is queued or a new picture is out with the OpenAI batch, ask the web app —
 * which holds the AI keys — to carry on, once a minute, as the admin who asked.
 */
async function maybeRunSocialAi(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastSocialAiTickAt < SOCIAL_AI_TICK_MS) return;
  lastSocialAiTickAt = now;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const pending = [...(await marketingAiPending(pool)), ...(await aiJobsPending(pool))].filter((t, i, all) => all.findIndex((x) => x.tenant_id === t.tenant_id) === i);
    for (const t of pending) {
      const u = await pool.query<{ sub: string; email: string; role: string; lid: string | null }>(
        `SELECT u.id::text AS sub, u.email, m.role,
                (SELECT l.id::text FROM locations l WHERE l.tenant_id = m.tenant_id ORDER BY l.created_at LIMIT 1) AS lid
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1::uuid AND m.role = 'admin'
          ORDER BY (u.id::text = $2) DESC, u.created_at LIMIT 1`,
        [t.tenant_id, t.requested_by ?? ""],
      );
      const a = u.rows[0];
      if (!a?.lid) continue;
      const token = await signSession({ sub: a.sub, email: a.email, tid: t.tenant_id, lid: a.lid, role: a.role });
      const res = await fetch(`${base}/api/marketing/ai/tick`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 202) console.error(`[worker] social ai tick → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  } catch (e) {
    console.error("[worker] social ai tick failed", e);
  }
}

/**
 * CarbonWMS Email: campaign sends, AI Designer turns, conversions and code
 * results run in the WEB app (it has the AWS, OpenAI and Shopify keys); the
 * worker calls /api/email/tick every minute while any of them is due.
 */
const EMAIL_TICK_MS = 60_000;
let lastEmailTickAt = 0;
async function maybeRunEmail(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastEmailTickAt < EMAIL_TICK_MS) return;
  lastEmailTickAt = now;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    for (const t of await emailWorkPending(pool)) {
      const u = await pool.query<{ sub: string; email: string; role: string; lid: string | null }>(
        `SELECT u.id::text AS sub, u.email, m.role,
                (SELECT l.id::text FROM locations l WHERE l.tenant_id = m.tenant_id ORDER BY l.created_at LIMIT 1) AS lid
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1::uuid AND m.role = 'admin'
          ORDER BY (u.email = $2) DESC, u.created_at LIMIT 1`,
        [t.tenant_id, t.requested_by ?? ""],
      );
      const a = u.rows[0];
      if (!a?.lid) continue;
      const token = await signSession({ sub: a.sub, email: a.email, tid: t.tenant_id, lid: a.lid, role: a.role });
      const res = await fetch(`${base}/api/email/tick`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 202) console.error(`[worker] email tick → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  } catch (e) {
    console.error("[worker] email tick failed", e);
  }
}

/**
 * CarbonWMS Creative (lib/server/creative): jobs run in the WEB app (OpenAI + fal.ai keys); the
 * worker calls /api/creative/tick once a minute while any is due, queues Radar's nightly collection
 * at 03:00 ET (only when CREATIVE_RADAR_NIGHTLY=1 — off by default, owner 2026-11-14) and the free learning refresh every 6 h. NOTHING here
 * generates pictures or video on a timer. Renders (HyperFrames HTML → MP4, free) run HERE, one at a
 * time, in the background so the rest of the loop keeps going.
 */
const CREATIVE_TICK_MS = 60_000;
let lastCreativeTickAt = 0;
let lastCreativeNightly = "";
let lastCreativeLearningAt = 0;
let creativeRenderBusy = false;
let lastCreativeRenderCheck = 0;
async function creativeTick(pool: Pool, tenantId: string, requestedBy: string | null, body: Record<string, unknown>, base: string) {
  const u = await pool.query<{ sub: string; email: string; role: string; lid: string | null }>(
    `SELECT u.id::text AS sub, u.email, m.role,
            (SELECT l.id::text FROM locations l WHERE l.tenant_id = m.tenant_id ORDER BY l.created_at LIMIT 1) AS lid
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1::uuid AND m.role = 'admin'
      ORDER BY (u.email = $2) DESC, u.created_at LIMIT 1`,
    [tenantId, requestedBy ?? ""],
  );
  const a = u.rows[0];
  if (!a?.lid) return;
  const token = await signSession({ sub: a.sub, email: a.email, tid: tenantId, lid: a.lid, role: a.role });
  const res = await fetch(`${base}/api/creative/tick`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (res.status !== 202) console.error(`[worker] creative tick → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
async function maybeRunCreative(pool: Pool): Promise<void> {
  if (!creativeRenderBusy && Date.now() - lastCreativeRenderCheck > 5000) {
    lastCreativeRenderCheck = Date.now();
    creativeRenderBusy = true;
    void runOneRender(pool)
      .catch((e) => console.error("[worker] creative render failed", e))
      .finally(() => {
        creativeRenderBusy = false;
      });
  }
  const now = Date.now();
  if (now - lastCreativeTickAt < CREATIVE_TICK_MS) return;
  lastCreativeTickAt = now;
  const base = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = `${et.getFullYear()}-${et.getMonth() + 1}-${et.getDate()}`;
    const nightly = et.getHours() === 3 && lastCreativeNightly !== day;
    const learning = now - lastCreativeLearningAt > 6 * 3600_000;
    const tenants = new Map<string, string | null>();
    for (const t of await creativePending(pool)) tenants.set(t.tenant_id, t.requested_by);
    if (nightly || learning) {
      const r = await pool.query<{ tenant_id: string }>(`SELECT tenant_id::text FROM creative_settings`).catch(() => ({ rows: [] as { tenant_id: string }[] }));
      for (const x of r.rows) if (!tenants.has(x.tenant_id)) tenants.set(x.tenant_id, null);
    }
    for (const [tid, by] of tenants) await creativeTick(pool, tid, by, { nightly, learning }, base);
    if (nightly) lastCreativeNightly = day;
    if (learning) lastCreativeLearningAt = now;
  } catch (e) {
    console.error("[worker] creative tick failed", e);
  }
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
      await maybeRunGradingAi(pool);
      await maybeRunShieldMaintenance(pool);
      await maybeRunMetaFeed(pool);
      await maybeRunMarketing(pool);
      await maybeRunSocialAi(pool);
      await maybeRunEmail(pool);
      await maybeRunCreative(pool);
      await maybeRunSeoWatch(pool);
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
