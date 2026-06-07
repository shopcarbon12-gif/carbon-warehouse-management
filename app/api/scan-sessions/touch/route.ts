import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { touchSessions } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Heartbeat for scan-sessions. A scanning page pings this every ~15s while it
 * is open so the readers it woke stay alive. When the page is closed or
 * navigated away the heartbeat stops, and the session janitor ends the
 * session(s) ~30s later (SCAN_SESSION_GRACE_MS) → the readers go cold.
 *
 * Body: { sessionIds: string[] }   (the ids the page got back from /start or /prewarm)
 * Response: { ok: true, refreshed: number }
 */
const bodySchema = z.object({
  sessionIds: z.array(z.string()).max(64),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const refreshed = touchSessions(parsed.data.sessionIds);
  return NextResponse.json({ ok: true, refreshed });
}
