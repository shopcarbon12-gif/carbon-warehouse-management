import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listSimMisplaceEpcs } from "@/lib/server/rfid-cycle-counts";

/** Misplace + unrecognized-style sample EPCs for UI simulation (no DB writes). */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const locationId = url.searchParams.get("locationId")?.trim();
  const binIdRaw = url.searchParams.get("binId")?.trim();
  const binId = binIdRaw && binIdRaw.length > 0 ? binIdRaw : null;

  if (!locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const misplaced = await listSimMisplaceEpcs(pool, session.tid, locationId, binId, 2);
    const hex = "0123456789ABCDEF";
    let ghost = "";
    for (let i = 0; i < 24; i += 1) {
      ghost += hex[Math.floor(Math.random() * 16)]!;
    }
    return NextResponse.json(
      { misplaced, unrecognized: [ghost] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Query failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[rfid/cycle-counts/sim-seeds]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
