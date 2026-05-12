import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { endSession, getSession } from "@/lib/server/antenna-test-sessions";
import { publishAntennaTestLifecycle } from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only stop for a raw reader-test session. Unlike the normal
 * /api/antenna-test/stop, this writes NOTHING to the database. The
 * session evaporates, supervisor sees an empty active-sessions list on
 * next poll, the reader respawns under its persisted config (paused if
 * paused, scanning if a scan-session is alive elsewhere).
 */
const bodySchema = z.object({ sessionId: z.string().uuid() });

export async function POST(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const denied = await requireSessionScopes(pool, userSession, [SCOPES.ADMIN]);
  if (denied) return denied;

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
    return NextResponse.json({ ok: true, alreadyEnded: true });
  }
  if (s.tenantId !== userSession.tid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  endSession(s.id);
  publishAntennaTestLifecycle(s.id, "ended", "stopped_by_operator");
  return NextResponse.json({
    ok: true,
    observedEpcCount: s.totalReadsCount,
  });
}
