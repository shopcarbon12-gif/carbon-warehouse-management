import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { performLightspeedCatalogSync } from "@/lib/server/inventory-sync";
import { randomUUID } from "node:crypto";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const idempotency_key = `ls-cat-${randomUUID()}`;
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO sync_jobs (
         tenant_id, location_id, job_type, status, idempotency_key, payload
       )
       VALUES ($1::uuid, $2::uuid, 'lightspeed_catalog', 'running', $3, $4::jsonb)
       RETURNING id::text`,
      [
        session.tid,
        session.lid,
        idempotency_key,
        JSON.stringify({
          trigger: "manual",
          user_id: session.sub,
          started_at: new Date().toISOString(),
        }),
      ],
    );
    const job_id = ins.rows[0]?.id;
    if (!job_id) {
      return NextResponse.json({ error: "Could not create sync job" }, { status: 500 });
    }

    const result = await performLightspeedCatalogSync(pool, job_id, session.tid, session.sub);

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, job_id: result.job_id },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      job_id: result.job_id,
      records_updated: result.records_updated,
      source: result.source,
      warnings: result.warnings,
      message:
        result.source === "live"
          ? "Catalog updated from Lightspeed."
          : "Catalog updated from simulated payload (live API unavailable or not configured).",
    });
  } catch (e) {
    console.error("[inventory/sync/trigger]", e);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
