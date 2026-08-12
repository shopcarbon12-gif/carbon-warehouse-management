import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk-link every unlinked matrix to its existing Shopify product. Runs in the
 * worker (768 products × Shopify calls). Single-flight. Admin.
 * Poll /api/shopify/sync/jobs/{id}/progress.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const active = await pool.query<{ id: string }>(
    `SELECT id::text FROM sync_jobs
      WHERE job_type = 'shopify_link_all' AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (active.rows[0]) return NextResponse.json({ job_id: active.rows[0].id, already_running: true });

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
     VALUES ($1::uuid, $2::uuid, 'shopify_link_all', 'queued', $3, $4::jsonb)
     RETURNING id::text`,
    [session.tid, session.lid, `shopify_link_all:${Date.now()}`, JSON.stringify({ user_id: session.sub })],
  );
  return NextResponse.json({ job_id: ins.rows[0].id, already_running: false });
}
