import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withActivity } from "@/lib/server/activity-log";
import { isStudioUpload, studioLabelsAuth as authed } from "@/lib/server/studio-labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carbon Studio jeans-label library — photos of the real back-waistband
 * labels / patches, uploaded once (bytes via /api/models/upload, like model
 * references) and picked per product when the item type is JEANS / DENIM SHORTS.
 *
 *   GET  /api/studio/labels            → { labels: [{ id, name, url, sourceUrl, createdAt }] }
 *     (sourceUrl: the original photo once the label has been cropped; null = not cropped yet)
 *   POST /api/studio/labels { url, name } → { label }
 */

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const r = await a.pool
    .query(
      `SELECT id::text, name, image_url, source_url, created_at FROM studio_jeans_labels
        WHERE tenant_id = $1::uuid AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      [a.session.tid],
    )
    .catch(() => ({ rows: [] as { id: string; name: string; image_url: string; source_url: string | null; created_at: string }[] }));
  return NextResponse.json({
    labels: r.rows.map((x) => ({ id: x.id, name: x.name, url: x.image_url, sourceUrl: x.source_url ?? null, createdAt: x.created_at })),
  });
}

async function POST_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const name = typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!isStudioUpload(url, a.session.tid)) {
    return NextResponse.json({ error: "Upload the label photo first." }, { status: 400 });
  }
  const r = await a.pool.query(
    `INSERT INTO studio_jeans_labels (tenant_id, name, image_url, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING id::text, name, image_url, created_at`,
    [a.session.tid, name, url, /^[0-9a-f-]{36}$/i.test(String(a.session.sub || "")) ? a.session.sub : null],
  );
  const x = r.rows[0];
  return NextResponse.json({ label: { id: x.id, name: x.name, url: x.image_url, sourceUrl: null, createdAt: x.created_at } });
}

export const POST = withActivity("studio/labels", POST_handler);
