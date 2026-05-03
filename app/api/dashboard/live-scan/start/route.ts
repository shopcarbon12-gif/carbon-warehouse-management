import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { upsertSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start (or re-affirm) the tenant's live-scan session. Idempotent: if a
 * session is already active, refreshes its lastSeenAt and returns it.
 *
 * Once a session exists, the agent's next config-poll (≤3 s) sees
 * `live_scan_active: true` and starts spawning reader binaries.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const s = upsertSession({ tenantId: session.tid, startedBy: session.sub });
  return NextResponse.json({
    ok: true,
    session_id: s.id,
    started_at: new Date(s.startedAt).toISOString(),
  });
}
