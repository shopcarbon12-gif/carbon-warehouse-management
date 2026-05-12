import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  if (!session.lid) {
    return NextResponse.json({ live_epc_count: 0 });
  }

  const r = await pool.query<{ live_epc_count: number }>(
    `SELECT COUNT(*)::int AS live_epc_count
       FROM items
      WHERE location_id = $1::uuid
        AND status = 'in-stock'`,
    [session.lid],
  );

  return NextResponse.json(
    { live_epc_count: r.rows[0]?.live_epc_count ?? 0 },
    { headers: { "Cache-Control": "no-store" } },
  );
}
