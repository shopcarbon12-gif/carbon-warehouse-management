import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Session-auth status poll for the Encode Items page. The workspace
 * hits this every ~1.5 s after queuing a job via /api/rfid/encode-
 * claim, flipping the row's status cell as soon as the agent reports
 * 'done' or 'failed'.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(_req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const { id } = await ctx.params;
  const r = await pool.query<{
    id: string;
    status: string;
    attempts: number;
    error_msg: string | null;
    started_at: string | null;
    finished_at: string | null;
    new_epc: string;
  }>(
    `SELECT id::text, status, attempts, error_msg,
            started_at::text, finished_at::text, new_epc
       FROM encode_jobs
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { ok: true, job: row },
    { headers: { "Cache-Control": "no-store" } },
  );
}
