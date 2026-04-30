import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listPendingTransfersForDestination } from "@/lib/server/operations-transfers";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

/**
 * GET /api/operations/transfers/pending?destinationLocationId=<uuid>
 *
 * Lists in-transit / partially_received transfers whose destination is the
 * requested location. Non-admins are forced to their session location;
 * admins may pass any tenant location to receive on their behalf.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const requested = searchParams.get("destinationLocationId")?.trim() ?? "";
  const admin = isAdminRole(session.role);

  const destinationLocationId = admin && requested.length > 0 ? requested : session.lid;
  if (!/^[0-9a-f-]{36}$/i.test(destinationLocationId)) {
    return NextResponse.json({ error: "Invalid destinationLocationId" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const rows = await listPendingTransfersForDestination(pool, session.tid, destinationLocationId);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[transfers/pending]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
