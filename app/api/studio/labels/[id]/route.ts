import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { isStudioUpload, studioLabelsAuth } from "@/lib/server/studio-labels";

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

/**
 * PATCH /api/studio/labels/<id> { url } — the label cropped to the patch alone.
 * The first crop keeps the original photo in source_url; image_url points at
 * the crop (the photo pasted into Pose 7). Nothing is deleted from storage.
 */
async function PATCH_handler(req: NextRequest, { params }: Ctx) {
  const a = await studioLabelsAuth(req);
  if ("error" in a) return a.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid label id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isStudioUpload(url, a.session.tid)) return NextResponse.json({ error: "Upload the cropped label first." }, { status: 400 });
  const r = await a.pool.query<{ id: string; name: string; image_url: string; source_url: string | null; created_at: string }>(
    `UPDATE studio_jeans_labels
        SET source_url = COALESCE(source_url, image_url), image_url = $3
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL
      RETURNING id::text, name, image_url, source_url, created_at`,
    [id, a.session.tid, url],
  );
  const x = r.rows[0];
  if (!x) return NextResponse.json({ error: "Label not found" }, { status: 404 });
  return NextResponse.json({ label: { id: x.id, name: x.name, url: x.image_url, sourceUrl: x.source_url, createdAt: x.created_at } });
}

export const DELETE = withActivity("studio/labels/[id]", DELETE_handler);
export const PATCH = withActivity("studio/labels/[id]", PATCH_handler);
