import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listTransferSlipReport } from "@/lib/server/operations-transfers";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

/**
 * GET /api/reports/transfers
 *   ?direction=out|in (default out)
 *   &q=...
 *   &state=all|in-transit|partially_received|received|cancelled
 *   &shippedFrom=YYYY-MM-DD&shippedTo=...&receivedFrom=...&receivedTo=...
 *   &page=1&limit=50
 *   &scopeLocationId= (admin only — defaults to session.lid)
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

  const { searchParams } = new URL(req.url);
  const direction = (searchParams.get("direction") ?? "out") as "out" | "in";
  const q = searchParams.get("q")?.trim() ?? "";
  const state = searchParams.get("state")?.trim() ?? "all";
  const shippedFrom = searchParams.get("shippedFrom")?.trim() || undefined;
  const shippedTo = searchParams.get("shippedTo")?.trim() || undefined;
  const receivedFrom = searchParams.get("receivedFrom")?.trim() || undefined;
  const receivedTo = searchParams.get("receivedTo")?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10) || 50));

  const requested = searchParams.get("scopeLocationId")?.trim() ?? "";
  const admin = isAdminRole(session.role);
  const scopeLocationId = admin && requested.length > 0 ? requested : session.lid;

  try {
    const result = await listTransferSlipReport(pool, session.tid, {
      q: q || undefined,
      state,
      shippedFrom,
      shippedTo,
      receivedFrom,
      receivedTo,
      direction,
      scopeLocationId,
      page,
      limit,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/transfers]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
