import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import {
  getCommandCenterKpis,
  listRecentAuditForTenant,
} from "@/lib/queries/dashboard-command";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const kpis = await getCommandCenterKpis(pool, session.lid);
    const activity = await listRecentAuditForTenant(pool, session.tid, 10);
    return NextResponse.json(
      { kpis, activity },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[dashboard/command]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 503 });
  }
}
