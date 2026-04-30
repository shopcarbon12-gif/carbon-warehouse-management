import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * GET /api/devices/printers — list label printers configured at the operator's
 * session location. Used by the Print Actions modal on Transfer In.
 *
 * Each printer's `network_address` is expected to follow the same shape as
 * the commissioning page's printer line — e.g. "192.168.1.3:80 / PSTPRNT" —
 * but a bare host or "host:port" is also accepted; the print endpoint applies
 * sensible fallbacks.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    const r = await pool.query<{
      id: string;
      name: string;
      network_address: string | null;
      status_online: boolean;
    }>(
      `SELECT id::text, name, network_address, status_online
       FROM devices
       WHERE tenant_id = $1::uuid
         AND location_id = $2::uuid
         AND device_type = 'printer'
       ORDER BY name ASC`,
      [session.tid, session.lid],
    );
    return NextResponse.json(
      { rows: r.rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[devices/printers]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
