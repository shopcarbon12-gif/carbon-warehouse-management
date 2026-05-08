import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { touchSession, getSession } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Heartbeat for an active scan-session. Browser pings this every ~25s while
 * the workflow page is open so the 60s idle timeout doesn't auto-drop the
 * session under an active operator.
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
    return NextResponse.json({ ok: false, expired: true }, { status: 410 });
  }
  if (s.tenantId !== userSession.tid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  touchSession(s.id);
  return NextResponse.json({ ok: true });
}
