import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;
type Ctx = { params: Promise<{ id: string }> };

/** Lightweight poll for a Shopify image-sync job's live progress. */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  const r = await pool.query<{
    status: string;
    progress_done: number;
    progress_total: number;
    progress_pct: number;
    progress_message: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    error: string | null;
    payload: { result?: Record<string, number> } | null;
  }>(
    `SELECT status, progress_done, progress_total, progress_pct, progress_message,
            started_at, finished_at, error, payload
       FROM sync_jobs
      WHERE id = $1::uuid
        AND job_type = 'shopify_image_sync'
        AND tenant_id = $2::uuid`,
    [id, session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  return NextResponse.json(
    {
      status: row.status,
      done: row.progress_done,
      total: row.progress_total,
      pct: row.progress_pct,
      message: row.progress_message,
      error: row.error,
      result: row.payload?.result ?? null,
      started_at: row.started_at ? row.started_at.toISOString() : null,
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
