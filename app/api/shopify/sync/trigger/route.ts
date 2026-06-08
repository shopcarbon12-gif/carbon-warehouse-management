import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enqueue a Shopify product-image sync. The actual work runs in the worker
 * (the full-catalog sweep takes minutes — far past an HTTP timeout), so this
 * just inserts a `shopify_image_sync` job (status 'queued') and returns its
 * id. Poll /api/shopify/sync/jobs/{id}/progress for status. Admin-only.
 *
 * Body (optional): { matrixId } to sync a single product; omit for all.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let body: { matrixId?: string } = {};
  try {
    body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  } catch {
    body = {};
  }
  const matrixId =
    typeof body.matrixId === "string" && body.matrixId.trim() ? body.matrixId.trim() : null;

  // One sweep at a time — return the in-flight job rather than stacking syncs
  // (each hammers the Shopify API).
  const active = await pool.query<{ id: string }>(
    `SELECT id::text FROM sync_jobs
      WHERE job_type = 'shopify_image_sync' AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (active.rows[0]) {
    return NextResponse.json({ job_id: active.rows[0].id, already_running: true });
  }

  const key = `shopify_image_sync:${session.tid}:${matrixId ?? "all"}:${Date.now()}`;
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, 'shopify_image_sync', 'queued', $3, $4::jsonb)
     RETURNING id::text`,
    [
      session.tid,
      session.lid,
      key,
      JSON.stringify({ trigger: "manual", user_id: session.sub, matrixId }),
    ],
  );
  return NextResponse.json({ job_id: ins.rows[0].id, already_running: false });
}
