import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { UUID_RE } from "@/lib/server/grading-app";
import { copyStorageObject, getStoragePublicUrl } from "@/lib/storageProvider";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST → the scan's photo goes into the product's Carbon Studio, in the FRONT
 * item-photo section (owner, 2026-10-13: "push the original taken picture to
 * the studio … under front"). It is the squared-up flat lay — straight from
 * above, cropped to the garment — which is what Studio wants as a reference.
 *
 * Copied into Studio's own reference folder (the only prefixes its photo proxy
 * serves) and added to studio_matrix_state.item_refs, which Studio restores
 * when it opens. Adding it twice does nothing.
 */
async function POST_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const s = (await pool.query<{ matrix_id: string; photo_key: string | null }>(
    `SELECT matrix_id, photo_key FROM size_grading_scans WHERE id = $1::uuid`, [id],
  )).rows[0];
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!s.photo_key) return NextResponse.json({ error: "This scan has no photo on the WMS yet." }, { status: 409 });

  const dest = `carbon-studio/item-refs/${session.tid}/grading-${id}/front.jpg`;
  const url = getStoragePublicUrl(dest);
  const state = (await pool.query<{ item_refs: { url: string; view: string }[] }>(
    `SELECT item_refs FROM studio_matrix_state WHERE matrix_id = $1::uuid`, [s.matrix_id],
  )).rows[0];
  if (state?.item_refs?.some((r) => r.url === url)) return NextResponse.json({ ok: true, url, already: true });

  await copyStorageObject(s.photo_key, dest);
  const ref = JSON.stringify([{ url, view: "front" }]);
  await pool.query(
    `INSERT INTO studio_matrix_state (matrix_id, tenant_id, updated_by, item_refs, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, now())
     ON CONFLICT (matrix_id) DO UPDATE
       SET item_refs = studio_matrix_state.item_refs || $4::jsonb, updated_by = $3::uuid, updated_at = now()`,
    [s.matrix_id, session.tid, session.sub ?? null, ref],
  );
  return NextResponse.json({ ok: true, url, already: false });
}

export const POST = withActivity("grading-app/scans/[id]/studio", POST_handler);
