import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/import — load a planned campaign (e.g. the AW2026 30-day
 * calendar) as DRAFT posts. Media must already be at public URLs (R2).
 *
 * Idempotent by sourceRef: running it again updates drafts in place, but never
 * touches a post someone has approved or that has already gone out.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";

export const dynamic = "force-dynamic";

const media = z.object({
  url: z.string().url().optional(),
  kind: z.enum(["image", "video"]).default("image"),
  storagePath: z.string().optional(),
  dropboxPath: z.string().optional(),
  coverUrl: z.string().url().optional(),
});
const tag = z.object({
  mediaPosition: z.number().int().min(0),
  metaProductId: z.string().regex(/^\d+$/),
  handle: z.string().optional(),
  label: z.string().max(200).default(""),
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
});
const post = z.object({
  sourceRef: z.string().min(1).max(200),
  title: z.string().max(200).default(""),
  format: z.enum(["image", "carousel", "reel", "story"]),
  caption: z.string().max(2200),
  hashtags: z.array(z.string()).max(30).default([]),
  linkUrl: z.string().url().optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  media: z.array(media.refine((m) => m.url || m.storagePath, "Each picture needs a url or a storagePath")).min(1).max(10),
  tags: z.array(tag).max(20).default([]),
  targets: z.array(z.enum(["instagram", "facebook", "bluesky"])).min(1).default(["instagram", "facebook"]),
});
const PUBLIC_BASE = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "https://wms.shopcarbon.com").trim().replace(/^'|'$/g, "").replace(/\/+$/, "");
const schema = z.object({ campaign: z.string().min(1).max(100), posts: z.array(post).min(1).max(100) }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid import" }, { status: 400 });
  const { campaign, posts } = parsed.data;
  let created = 0;
  let updated = 0;
  let kept = 0;
  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of posts) {
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM marketing_posts WHERE tenant_id = $1::uuid AND source_ref = $2`,
        [g.session.tid, p.sourceRef],
      );
      const row = existing.rows[0];
      if (row && !["draft", "changes_requested"].includes(row.status)) {
        kept++;
        continue;
      }
      let id: string;
      if (row) {
        id = row.id;
        await client.query(
          `UPDATE marketing_posts SET campaign = $2, title = $3, format = $4, caption = $5, hashtags = $6, link_url = $7, scheduled_at = $8, updated_at = now()
            WHERE id = $1::uuid`,
          [id, campaign, p.title, p.format, p.caption, p.hashtags, p.linkUrl ?? null, p.scheduledAt],
        );
        await client.query(`DELETE FROM marketing_post_media WHERE post_id = $1::uuid`, [id]);
        await client.query(`DELETE FROM marketing_post_tags WHERE post_id = $1::uuid`, [id]);
        await client.query(`DELETE FROM marketing_post_targets WHERE post_id = $1::uuid`, [id]);
        updated++;
      } else {
        const r = await client.query<{ id: string }>(
          `INSERT INTO marketing_posts (tenant_id, campaign, source_ref, title, format, caption, hashtags, link_url, scheduled_at, status, created_by)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10) RETURNING id`,
          [g.session.tid, campaign, p.sourceRef, p.title, p.format, p.caption, p.hashtags, p.linkUrl ?? null, p.scheduledAt, g.session.email ?? null],
        );
        id = r.rows[0].id;
        created++;
      }
      for (const [i, m] of p.media.entries()) {
        // Files on our private R2 are served through the public marketing-media route.
        const ins = await client.query<{ id: string }>(
          `INSERT INTO marketing_post_media (post_id, position, kind, url, storage_path, dropbox_path, cover_url) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [id, i, m.kind, m.url ?? "", m.storagePath ?? null, m.dropboxPath ?? null, m.coverUrl ?? null],
        );
        if (!m.url) {
          const ext = m.kind === "video" ? "mp4" : "jpg";
          await client.query(`UPDATE marketing_post_media SET url = $2 WHERE id = $1::uuid`, [ins.rows[0].id, `${PUBLIC_BASE}/api/public/marketing-media/${ins.rows[0].id}.${ext}`]);
        }
      }
      for (const t of p.tags)
        await client.query(
          `INSERT INTO marketing_post_tags (post_id, media_position, meta_product_id, shopify_handle, label, x, y) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
          [id, t.mediaPosition, t.metaProductId, t.handle ?? null, t.label, t.x, t.y],
        );
      for (const t of p.targets) await client.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2)`, [id, t]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return NextResponse.json({ created, updated, kept });
}

export const POST = withActivity("marketing/import", POST_handler);
