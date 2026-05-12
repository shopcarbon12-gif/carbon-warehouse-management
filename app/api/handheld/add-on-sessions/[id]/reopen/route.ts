import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { isSuperAdminRole } from "@/lib/auth/roles";
import { reopenSession } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/handheld/add-on-sessions/<id>/reopen
 *
 * Super-admin-only endpoint to flip a completed Add-On session back to
 * 'paused' so the operator can keep scanning. EPC ledger + failed ledger
 * are preserved. The next finalize creates a new inventory_reports row;
 * the original one is left in place as a historical record.
 *
 * Auth: requires a browser-session bearer (handheld auth uses session
 * cookies forwarded from the login flow) — the edge-API-key path is
 * deliberately not accepted because the role check needs a real user.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const session = await getSessionFromRequest(_req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSuperAdminRole(session.role)) {
    return NextResponse.json(
      { error: "Only super-admin may re-open a completed Add-On session" },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;

  try {
    const updated = await reopenSession(
      pool,
      session.tid,
      id,
      session.sub,
      null,
    );
    if (!updated) {
      return NextResponse.json(
        { error: "Session not found or not in completed state" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      id: updated.id,
      state: updated.state,
      source_type: updated.source_type,
      source_id: updated.source_id,
      source_slip: updated.source_slip,
    });
  } catch (e) {
    console.error("[handheld/add-on-sessions/<id>/reopen POST]", e);
    return NextResponse.json({ error: "Reopen failed" }, { status: 500 });
  }
}
