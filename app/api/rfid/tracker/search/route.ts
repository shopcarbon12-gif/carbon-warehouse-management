import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { searchEpcTracker } from "@/lib/server/rfid-tracker";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json({ result: { mode: "pick", matches: [] } });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const result = await searchEpcTracker(pool, session.tid, q);
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[rfid/tracker/search]", e);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
