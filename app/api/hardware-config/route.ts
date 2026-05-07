import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { buildHardwareConfigTree } from "@/lib/server/hardware-config";

/**
 * Returns the hardware hierarchy for the user's *active location*:
 * Location → Zones → Readers → Antennas, plus any unzoned readers.
 * Used by the /hardware_config admin UI. Scoped by session.lid so a user
 * working out of FL Mall doesn't see Orlando's CDM agents, zones, or
 * readers in the tree.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    const tree = await buildHardwareConfigTree(pool, session.tid, session.lid);
    return NextResponse.json(tree, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[hardware-config GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
