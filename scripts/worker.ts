import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { executeLightspeedCatalogJob } from "@/lib/server/inventory-sync";

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

async function processStub(pool: Pool, job: JobRow): Promise<void> {
  if (job.job_type === "lightspeed_catalog") {
    await executeLightspeedCatalogJob(pool, job.id);
    /* Terminal status + payload are set inside the catalog sync (no generic completed UPDATE). */
    return;
  }
  // Stub: real Lightspeed/Shopify calls go here. Idempotency is enforced by idempotency_key on insert.
  await sleep(50 + Math.floor(Math.random() * 80));
  if (job.job_type === "shopify_push" && job.attempts > 2) {
    throw new Error("simulated transient failure");
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
      const job = await claimJob(pool);
      if (!job) {
        await sleep(800);
        continue;
      }
      try {
        await processStub(pool, job);
        if (job.job_type !== "lightspeed_catalog") {
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
