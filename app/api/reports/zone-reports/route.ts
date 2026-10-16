import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → the latest zone reports (Zone Management assign / remove), newest
 * first — the handheld's Reports → Zones list. Same rows as the desktop's
 * Reports → Device Upload Logs ("Zone assign · STORE · …").
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const r = await pool.query<{ id: string; device_id: string; workflow_mode: string; created_at: Date; device_name: string | null }>(
    `SELECT u.id::text, u.device_id, u.workflow_mode, u.created_at, d.name AS device_name
       FROM device_upload_logs u
       LEFT JOIN devices d ON d.android_id = u.device_id AND d.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid AND u.workflow_mode LIKE 'Zone %'
      ORDER BY u.created_at DESC
      LIMIT 200`,
    [session.tid],
  );
  return NextResponse.json(
    {
      reports: r.rows.map((x) => ({
        id: Number(x.id),
        mode: x.workflow_mode,
        device: x.device_name ?? x.device_id,
        createdAt: x.created_at.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
