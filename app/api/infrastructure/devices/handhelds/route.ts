import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listAuthorizedHandheldsForTenant } from "@/lib/server/infrastructure-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approved handhelds for the catalog "Send to handheld" drawer. */
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
    const rows = await listAuthorizedHandheldsForTenant(pool, session.tid);
    /* Strip the `config` blob (may contain device-private fields). */
    const trimmed = rows.map((r) => ({
      id: r.id,
      name: r.name,
      device_type: r.device_type,
      location_id: r.location_id,
      location_code: r.location_code,
      location_name: r.location_name,
      status_online: r.status_online,
    }));
    return NextResponse.json(trimmed, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[infrastructure/devices/handhelds]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
