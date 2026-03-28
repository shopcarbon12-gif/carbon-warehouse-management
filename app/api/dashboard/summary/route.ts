import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { getDashboardKpis } from "@/lib/queries/dashboard";

export async function GET() {
  const session = await getSession();
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
