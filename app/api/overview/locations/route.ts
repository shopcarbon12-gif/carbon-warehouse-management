import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listTenantLocationsWithBins } from "@/lib/server/overview-locations";

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
    const locations = await listTenantLocationsWithBins(pool, session.tid);
    return NextResponse.json({ locations }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[overview/locations]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
