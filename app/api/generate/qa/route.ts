import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { claimPanelQa, isValidQaId } from "@/lib/server/panel-qa-store";

/**
 * Collect the compliance verdict for a panel whose image was already served.
 *
 * The judge runs after the response so the operator sees the render as soon as
 * OpenAI finishes it; this is where the flags catch up.
 *
 * GET ?id=<qaId> → { status: "running" | "missing" } | { status: "done", … }
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!isValidQaId(id)) return NextResponse.json({ error: "Invalid QA id" }, { status: 400 });

  const claimed = claimPanelQa(id);
  if (claimed.status === "missing") {
    /* Expired, already collected, or the server restarted while judging. The
       Studio treats this as "no verdict", never as a pass. */
    return NextResponse.json({ status: "missing" }, { status: 404 });
  }
  if (claimed.status === "running") {
    return NextResponse.json({ status: "running" }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { status: "done", ...claimed.verdict },
    { headers: { "Cache-Control": "no-store" } },
  );
}
