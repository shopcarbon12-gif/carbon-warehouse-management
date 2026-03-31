import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { getDashboardKpis } from "@/lib/queries/dashboard";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const kpis = await withDb(
    (sql) => getDashboardKpis(sql, session.tid, session.lid),
    {
      inventory_units: 0,
      order_open: 0,
      exceptions_open: 0,
      sync_pending: 0,
    },
  );
  return NextResponse.json(kpis);
}
