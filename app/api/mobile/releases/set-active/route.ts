import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { setActiveReleaseById } from "@/lib/queries/app-releases";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let body: { releaseId?: unknown };
  try {
    body = (await req.json()) as { releaseId?: unknown };
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const releaseId = Number(body.releaseId);
  if (!Number.isFinite(releaseId) || releaseId < 1) {
    return NextResponse.json({ error: "releaseId required" }, { status: 400 });
  }

  const ok = await setActiveReleaseById(pool, session.tid, releaseId);
  if (!ok) return NextResponse.json({ error: "Release not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
