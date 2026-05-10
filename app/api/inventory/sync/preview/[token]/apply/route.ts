import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { applyLightspeedSyncFromPreview } from "@/lib/server/lightspeed-sync-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PREVIEW_AGE_MIN = 30;

/**
 * POST /api/inventory/sync/preview/[token]/apply
 *
 * Step 3 — operator pressed "Confirm sync" in the modal. We:
 *   1. Look up the cached preview by token
 *   2. Reject if older than 30 minutes (Lightspeed may have moved on; force a fresh preview)
 *   3. Move job into 'running' status, then return immediately so the
 *      modal can close and the global progress bar can take over
 *   4. Run the apply phase as a background promise (no await) — the
 *      sync_jobs row is the queue + the progress channel; the response
 *      is unblocked
 *
 * Returns: { job_id } so the frontend can poll
 *   GET /api/inventory/sync/jobs/[id]/progress
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { token } = await ctx.params;
  if (!/^pv-[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ error: "Invalid preview token" }, { status: 400 });
  }

  const r = await pool.query<{
    id: string;
    tenant_id: string;
    status: string;
    created_at: string;
  }>(
    `SELECT id::text, tenant_id::text, status, created_at::text
       FROM sync_jobs
      WHERE preview_token = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    [token, session.tid],
  );
  const row = r.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Preview not found" }, { status: 404 });
  }
  if (row.status !== "preview") {
    return NextResponse.json(
      { error: `Preview already ${row.status}` },
      { status: 409 },
    );
  }
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > MAX_PREVIEW_AGE_MIN * 60_000) {
    return NextResponse.json(
      { error: "Preview expired. Run Sync Lightspeed again to get a fresh preview." },
      { status: 410 },
    );
  }

  await pool.query(
    `UPDATE sync_jobs
        SET status = 'running',
            started_at = now(),
            progress_message = 'Preparing apply…',
            updated_at = now()
      WHERE id = $1::uuid`,
    [row.id],
  );

  // Fire-and-forget: do NOT await. Response returns now; the apply phase
  // continues in this Node process and writes progress to sync_jobs as it
  // goes. The frontend polls /jobs/[id]/progress to drive the top-right bar.
  void applyLightspeedSyncFromPreview(pool, row.id, row.tenant_id, session.sub).catch(
    (err) => {
      console.error("[lightspeed-sync apply] background failure", err);
    },
  );

  return NextResponse.json(
    { ok: true, job_id: row.id },
    { headers: { "Cache-Control": "no-store" } },
  );
}
