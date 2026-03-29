import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { searchSkusForCommission } from "@/lib/queries/rfid-commission";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ matches: [] });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const matches = await searchSkusForCommission(pool, q, 25);
    return NextResponse.json({ matches }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[rfid/catalog-search]", e);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
