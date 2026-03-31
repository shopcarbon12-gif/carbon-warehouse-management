import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listDeviceUploadLogs } from "@/lib/queries/device-upload-logs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  try {
    const rows = await listDeviceUploadLogs(pool, session.tid, 200);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/upload-logs]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
