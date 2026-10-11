import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;
type Ctx = { params: Promise<{ id: string }> };

/** Progress + full result of a Translate / Sync ads run. */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const r = await pool.query<{
    job_type: string;
    status: string;
    progress_done: number;
    progress_total: number;
    progress_pct: number;
    progress_message: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    error: string | null;
    payload: { result?: unknown; fullTitleCheck?: boolean } | null;
  }>(
    `SELECT job_type, status, progress_done, progress_total, progress_pct, progress_message,
            started_at, finished_at, error, payload
       FROM sync_jobs
      WHERE id = $1::uuid AND tenant_id = $2::uuid
        AND job_type IN ('shopify_translate','shopify_ads_sync')`,
    [id, session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json(
    {
      type: row.job_type === "shopify_translate" ? "translate" : "ads",
      status: row.status,
      done: row.progress_done,
      total: row.progress_total,
      pct: row.progress_pct,
      message: row.progress_message,
      error: row.error,
      full_title_check: Boolean(row.payload?.fullTitleCheck),
      result: row.payload?.result ?? null,
      started_at: row.started_at?.toISOString() ?? null,
      finished_at: row.finished_at?.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
