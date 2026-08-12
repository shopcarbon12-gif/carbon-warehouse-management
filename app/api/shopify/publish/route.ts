import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  validateMatrixForPublish,
  type PublishVariantRow,
} from "@/lib/server/shopify-publish-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check &amp; Publish a matrix to Shopify (M1/P1.5).
 *
 * Validates immediately (fast fail on duplicate SKUs / missing options / no
 * price), marks the matrix `checked`, then enqueues a `shopify_product_push`
 * worker job (create-or-update product + variants + inventory + publish).
 * Single-flight per matrix. Poll /api/shopify/sync/jobs/{id}/progress. Admin.
 *
 * Body: { matrixId }
 * 200:  { job_id, already_running }
 * 422:  { error, code: "VALIDATION", errors: string[] }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  const matrixId =
    typeof body.matrixId === "string" && body.matrixId.trim() ? body.matrixId.trim() : null;
  if (!matrixId) {
    return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  }

  const exists = await pool.query(`SELECT 1 FROM matrices WHERE id = $1::uuid`, [matrixId]);
  if (!exists.rows[0]) {
    return NextResponse.json({ error: "Matrix not found" }, { status: 404 });
  }

  // Immediate validation so the operator gets an actionable error, not a
  // silently-held job.
  const vr = await pool.query<PublishVariantRow>(
    `SELECT id::text, sku, color_code, size, retail_price::text AS retail_price
       FROM custom_skus WHERE matrix_id = $1::uuid AND archived = FALSE`,
    [matrixId],
  );
  const val = await validateMatrixForPublish(pool, matrixId, vr.rows);
  if (!val.ok) {
    return NextResponse.json(
      { error: "Cannot publish", code: "VALIDATION", errors: val.errors },
      { status: 422 },
    );
  }

  // Mark checked.
  await pool.query(
    `UPDATE matrices SET checked_at = now(), checked_by = $2::uuid, shopify_sync_status = 'pending'
      WHERE id = $1::uuid`,
    [matrixId, session.sub],
  );

  // Single-flight per matrix.
  const active = await pool.query<{ id: string }>(
    `SELECT id::text FROM sync_jobs
      WHERE job_type = 'shopify_product_push'
        AND status IN ('queued','running')
        AND payload->>'matrixId' = $1
      ORDER BY created_at DESC LIMIT 1`,
    [matrixId],
  );
  if (active.rows[0]) {
    return NextResponse.json({ job_id: active.rows[0].id, already_running: true });
  }

  const key = `shopify_product_push:${matrixId}:${Date.now()}`;
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, 'shopify_product_push', 'queued', $3, $4::jsonb)
     RETURNING id::text`,
    [
      session.tid,
      session.lid,
      key,
      JSON.stringify({
        matrixId,
        locationId: session.lid,
        user_id: session.sub,
        trigger: "check_and_publish",
      }),
    ],
  );
  return NextResponse.json({ job_id: ins.rows[0].id, already_running: false });
}
