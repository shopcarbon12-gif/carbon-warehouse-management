import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listRecentAuditForTenant } from "@/lib/queries/dashboard-command";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const url = new URL(req.url);
  const lim = Math.min(500, Math.max(10, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));

  try {
    const activity = await listRecentAuditForTenant(pool, session.tid, lim);
    return NextResponse.json(activity, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/audit]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
