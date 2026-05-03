import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { endSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End the tenant's live-scan session immediately. The agent's next
 * config-poll (≤3 s) sees `live_scan_active: false` and SIGTERMs every
 * reader child. No further reads land in cdm_reads from fixed readers.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  endSession(session.tid);
  return NextResponse.json({ ok: true });
}
