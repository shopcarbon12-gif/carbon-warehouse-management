import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listExpectedCycleCountItems } from "@/lib/server/rfid-cycle-counts";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const locationId = url.searchParams.get("locationId")?.trim();
  const binIdRaw = url.searchParams.get("binId")?.trim();

  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }

  const binId =
    binIdRaw && binIdRaw.length > 0 ? binIdRaw : null;

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const rows = await listExpectedCycleCountItems(
      pool,
      session.tid,
      locationId,
      binId,
    );
    return NextResponse.json({ expected: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Query failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[rfid/cycle-counts/expected]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
