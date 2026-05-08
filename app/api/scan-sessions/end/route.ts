import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { endSession, getSession } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End a scan-session. Called from the page on commit (Transfer Out /
 * Cycle Counts / Print-Commission). The agent's next active-sessions
 * poll won't see this session, the supervisor will see no override, and
 * (if scan_paused_at on the reader is set) the supervisor will kill the
 * child, re-pausing the reader within ~250ms.
 *
 * Body: { sessionId }
 */

const bodySchema = z.object({ sessionId: z.string().uuid() });

export async function POST(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const s = getSession(parsed.data.sessionId);
  if (!s) {
    // Already gone (idle-expired or already ended) — treat as success so
    // the caller's commit flow doesn't fail on a benign race.
    return NextResponse.json({ ok: true, alreadyEnded: true });
  }
  if (s.tenantId !== userSession.tid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  endSession(s.id);
  return NextResponse.json({ ok: true });
}
