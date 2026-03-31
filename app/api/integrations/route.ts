import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { listIntegrations } from "@/lib/queries/integrations";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await withDb(
    (sql) => listIntegrations(sql, session.tid, session.lid),
    [],
  );
  return NextResponse.json(rows);
}
