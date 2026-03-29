import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listRfidPrintAudit } from "@/lib/queries/rfid-commission";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw ?? "50", 10) || 50));

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const rows = await listRfidPrintAudit(pool, session.tid, { limit, q });
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[rfid/print-logs]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
