import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listRecentReadsForTenant } from "@/lib/server/cdm-agents";

/**
 * Recent CDM tag reads for the current tenant. Used by the Hardware Config
 * UI to show a live tail of incoming reads.
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
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
    : 50;
  try {
    const reads = await listRecentReadsForTenant(pool, session.tid, limit);
    return NextResponse.json({ reads }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[cdm-agents/recent-reads]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
