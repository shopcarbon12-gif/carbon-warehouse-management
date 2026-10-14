import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/studio/labels/<id> — takes a label out of the library (the photo is kept on storage). */
async function DELETE_handler(req: NextRequest, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid label id" }, { status: 400 });
  const r = await pool.query(
    `UPDATE studio_jeans_labels SET archived_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`,
    [id, session.tid],
  );
  if (!r.rowCount) return NextResponse.json({ error: "Label not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withActivity("studio/labels/[id]", DELETE_handler);
