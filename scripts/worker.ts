import { loadEnvConfig } from "@next/env";
import postgres from "postgres";

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

async function claimJob(sql: ReturnType<typeof postgres>): Promise<JobRow | null> {
  const rows = await sql<JobRow[]>`
    UPDATE sync_jobs
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
    RETURNING id, job_type, tenant_id, location_id, attempts
  `;
  return rows[0] ?? null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processStub(job: JobRow): Promise<void> {
  // Stub: real Lightspeed/Shopify calls go here. Idempotency is enforced by idempotency_key on insert.
  await sleep(50 + Math.floor(Math.random() * 80));
  if (job.job_type === "shopify_push" && job.attempts > 2) {
    throw new Error("simulated transient failure");
  }
}

async function main() {
  const sql = postgres(databaseUrl, { max: 2, prepare: false });
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
      const job = await claimJob(sql);
      if (!job) {
        await sleep(800);
        continue;
      }
      try {
        await processStub(job);
        await sql`
          UPDATE sync_jobs
          SET status = 'completed', error = NULL, updated_at = now()
          WHERE id = ${job.id}::uuid
        `;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await sql`
          UPDATE sync_jobs
          SET status = 'failed', error = ${msg}, updated_at = now()
          WHERE id = ${job.id}::uuid
        `;
      }
    } catch (e) {
      console.error("[worker loop]", e);
      await sleep(2000);
    }
  }

  await sql.end();
  console.log("WMS worker stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
