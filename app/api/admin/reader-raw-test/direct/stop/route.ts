import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  getDirectSession,
  stopDirectSession,
} from "@/lib/server/raw-test-direct";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const s = getDirectSession(parsed.data.sessionId);
  if (!s) {
    return NextResponse.json({ ok: true, alreadyEnded: true });
  }
  if (s.tenantId !== userSession.tid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  stopDirectSession(s.id, "stopped_by_operator");
  return NextResponse.json({
    ok: true,
    totalReads: s.totalReads,
    uniqueEpcs: s.uniqueEpcs.size,
  });
}
