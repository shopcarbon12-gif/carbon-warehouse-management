import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { tryGetStoragePathFromUrl } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carbon Studio jeans-label library — photos of the real back-waistband
 * labels / patches, uploaded once (bytes via /api/models/upload, like model
 * references) and picked per product when the item type is JEANS / DENIM SHORTS.
 *
 *   GET  /api/studio/labels            → { labels: [{ id, name, url, createdAt }] }
 *   POST /api/studio/labels { url, name } → { label }
 */

async function authed(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const r = await a.pool
    .query(
      `SELECT id::text, name, image_url, created_at FROM studio_jeans_labels
        WHERE tenant_id = $1::uuid AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      [a.session.tid],
    )
    .catch(() => ({ rows: [] as { id: string; name: string; image_url: string; created_at: string }[] }));
  return NextResponse.json({
    labels: r.rows.map((x) => ({ id: x.id, name: x.name, url: x.image_url, createdAt: x.created_at })),
  });
}

async function POST_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const name = typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  /* Only a photo uploaded through the Studio itself: its upload, or the phone
     camera hand-off (those objects are kept; see /api/image-handoff). */
  const path = url ? tryGetStoragePathFromUrl(url) : "";
  if (!path || !(path.startsWith(`carbon-studio/item-refs/${a.session.tid}/`) || path.startsWith("carbon-studio/handoff/"))) {
    return NextResponse.json({ error: "Upload the label photo first." }, { status: 400 });
  }
  const r = await a.pool.query(
    `INSERT INTO studio_jeans_labels (tenant_id, name, image_url, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING id::text, name, image_url, created_at`,
    [a.session.tid, name, url, /^[0-9a-f-]{36}$/i.test(String(a.session.sub || "")) ? a.session.sub : null],
  );
  const x = r.rows[0];
  return NextResponse.json({ label: { id: x.id, name: x.name, url: x.image_url, createdAt: x.created_at } });
}

export const POST = withActivity("studio/labels", POST_handler);
