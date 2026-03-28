import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listIntegrations } from "@/lib/queries/integrations";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await withDb(
    (sql) => listIntegrations(sql, session.tid, session.lid),
    [],
  );
  return NextResponse.json(rows);
}
