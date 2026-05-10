import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/inventory/sync/jobs/[id]/progress
 *
 * Cheap, frequently-polled (~1.5s) endpoint that drives the global
 * top-right sync progress bar. Tenant-scoped — a job from another tenant
 * 404s. Returns minimal fields so we don't waste bandwidth on every tick.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Bad job id" }, { status: 400 });
  }

  const r = await pool.query<{
    status: string;
    progress_done: number;
    progress_total: number;
    progress_pct: number;
    progress_message: string | null;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    payload: { records_inserted_or_updated?: number; records_archived?: number; warnings?: string[] } | null;
  }>(
    `SELECT status, progress_done, progress_total, progress_pct, progress_message,
            started_at::text, finished_at::text, error, payload
       FROM sync_jobs
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [id, session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ETA: linear extrapolation. Good enough for a progress bar; precise enough
  // that the operator gets a useful "30s remaining" instead of "?".
  let eta_seconds: number | null = null;
  if (row.status === "running" && row.started_at && row.progress_done > 0) {
    const elapsedMs = Date.now() - new Date(row.started_at).getTime();
    const rate = row.progress_done / elapsedMs;
    if (rate > 0) {
      const remaining = row.progress_total - row.progress_done;
      eta_seconds = Math.max(0, Math.round(remaining / rate / 1000));
    }
  }

  return NextResponse.json(
    {
      status: row.status,
      progress_done: row.progress_done,
      progress_total: row.progress_total,
      progress_pct: row.progress_pct,
      progress_message: row.progress_message ?? "",
      eta_seconds,
      error: row.error,
      records_inserted_or_updated: row.payload?.records_inserted_or_updated ?? null,
      records_archived: row.payload?.records_archived ?? null,
      warnings: row.payload?.warnings ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
