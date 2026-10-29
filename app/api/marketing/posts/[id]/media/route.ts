import { withActivity } from "@/lib/server/activity-log";
/**
 * The pictures and videos of one Social post (owner, 2026-10-25: make posts
 * in CarbonWMS and the app, Reel covers).
 *
 *   POST   multipart: file, role = "media" (default) | "cover" (+ position of the video)
 *   DELETE ?position=N   — removes it and its product tags; the rest move up
 *   PATCH  { order: [positions] } — new order (tags move with their picture)
 *
 * Files go to our private R2 and are served publicly by
 * /api/public/marketing-media/<id>.jpg|.mp4 (and <id>-cover.jpg), which is
 * what Instagram and Facebook fetch. Pictures are stored as JPEG (Instagram
 * takes no PNG/HEIC). Any change sends an approved post back for approval.
 */
import { NextResponse } from "next/server";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts, publicMediaUrl } from "@/lib/server/marketing/store";
import { uploadBytesToStorage } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_ITEMS = 10;
const MAX_BYTES = 250 * 1024 * 1024;

async function editable(client: PoolClient, tenantId: string, id: string): Promise<string | null> {
  const r = await client.query<{ status: string }>(`SELECT status FROM marketing_posts WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`, [id, tenantId]);
  const s = r.rows[0]?.status;
  if (!s) return "Post not found";
  if (["publishing", "published", "partly_published"].includes(s)) return "This post has already gone out and cannot be changed";
  return null;
}

/**
 * Format follows the media (one picture, several, a video) and an approved post needs approving again.
 * A Story stays a Story and a Reel stays a Reel: a Reel's extra picture is its cover, never a
 * carousel slide (a carousel would drop the video on Facebook and lose Reels reach on Instagram).
 */
async function settle(client: PoolClient, id: string) {
  const m = await client.query<{ kind: string }>(`SELECT kind FROM marketing_post_media WHERE post_id = $1::uuid ORDER BY position`, [id]);
  const kinds = m.rows.map((r) => r.kind);
  await client.query(
    `UPDATE marketing_posts SET
        format = CASE
          WHEN format = 'story' THEN 'story'
          WHEN format = 'reel' THEN 'reel'
          WHEN $2::int = 1 AND $3::boolean THEN 'reel'
          WHEN $2::int > 1 THEN 'carousel'
          ELSE 'image' END,
        status = CASE WHEN status = 'approved' THEN 'draft' ELSE status END,
        approved_by = CASE WHEN status = 'approved' THEN NULL ELSE approved_by END,
        approved_at = CASE WHEN status = 'approved' THEN NULL ELSE approved_at END,
        updated_at = now()
      WHERE id = $1::uuid`,
    [id, kinds.length, kinds[0] === "video"],
  );
}

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the file as multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "That file is larger than 250 MB" }, { status: 413 });
  const role = String(form.get("role") || "media");
  const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(file.name);
  if (!isVideo && !file.type.startsWith("image/") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name))
    return NextResponse.json({ error: "Pictures (JPEG, PNG, WebP, HEIC) or videos (MP4, MOV) only" }, { status: 415 });
  if (role === "cover" && isVideo) return NextResponse.json({ error: "A cover is a picture" }, { status: 415 });

  // Pictures become JPEG (Instagram's format), turned the right way up, at most 3,000 px.
  let bytes: Buffer = Buffer.from(await file.arrayBuffer());
  let contentType = isVideo ? (/\.mov$/i.test(file.name) || file.type === "video/quicktime" ? "video/quicktime" : "video/mp4") : "image/jpeg";
  if (!isVideo) {
    try {
      bytes = await sharp(bytes).rotate().resize(3000, 3000, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    } catch {
      return NextResponse.json({ error: "That picture could not be read" }, { status: 415 });
    }
    contentType = "image/jpeg";
  }
  const ext = isVideo ? (contentType === "video/quicktime" ? "mov" : "mp4") : "jpg";

  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    const why = await editable(client, g.session.tid, id);
    if (why) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: why }, { status: why === "Post not found" ? 404 : 409 });
    }
    // A picture added to a Reel that already has its video is the Reel's cover.
    const fmt = await client.query<{ format: string; video: number | null }>(
      `SELECT p.format, (SELECT m.position FROM marketing_post_media m WHERE m.post_id = p.id AND m.kind = 'video' ORDER BY m.position LIMIT 1) AS video
         FROM marketing_posts p WHERE p.id = $1::uuid`,
      [id],
    );
    const reelCover = role !== "cover" && !isVideo && fmt.rows[0]?.format === "reel" && fmt.rows[0]?.video != null;
    if (role === "cover" || reelCover) {
      const position = reelCover ? Number(fmt.rows[0].video) : Number(form.get("position") ?? 0);
      const v = await client.query<{ id: string }>(
        `SELECT id FROM marketing_post_media WHERE post_id = $1::uuid AND position = $2 AND kind = 'video'`,
        [id, position],
      );
      const mediaId = v.rows[0]?.id;
      if (!mediaId) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "There is no video at that place to put a cover on" }, { status: 400 });
      }
      const path = `marketing/uploads/${id}/${mediaId}-cover-${Date.now()}.jpg`;
      await uploadBytesToStorage({ path, bytes, contentType });
      await client.query(`UPDATE marketing_post_media SET cover_storage_path = $2, cover_url = $3 WHERE id = $1::uuid`, [
        mediaId, path, `${publicMediaUrl(mediaId, "image", true)}?v=${Date.now()}`,
      ]);
    } else {
      const n = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM marketing_post_media WHERE post_id = $1::uuid`, [id]);
      if (n.rows[0].n >= MAX_ITEMS) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: `A post holds at most ${MAX_ITEMS} pictures or videos` }, { status: 400 });
      }
      const ins = await client.query<{ id: string }>(
        `INSERT INTO marketing_post_media (post_id, position, kind, url) VALUES ($1::uuid, $2, $3, '') RETURNING id`,
        [id, n.rows[0].n, isVideo ? "video" : "image"],
      );
      const mediaId = ins.rows[0].id;
      const path = `marketing/uploads/${id}/${mediaId}.${ext}`;
      await uploadBytesToStorage({ path, bytes, contentType });
      await client.query(`UPDATE marketing_post_media SET storage_path = $2, url = $3 WHERE id = $1::uuid`, [mediaId, path, publicMediaUrl(mediaId, isVideo ? "video" : "image")]);
    }
    await settle(client, id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  return NextResponse.json({ post });
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  const position = Number(new URL(req.url).searchParams.get("position"));
  if (!Number.isInteger(position) || position < 0) return NextResponse.json({ error: "Which picture?" }, { status: 400 });
  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    const why = await editable(client, g.session.tid, id);
    if (why) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: why }, { status: why === "Post not found" ? 404 : 409 });
    }
    await client.query(`DELETE FROM marketing_post_media WHERE post_id = $1::uuid AND position = $2`, [id, position]);
    await client.query(`DELETE FROM marketing_post_tags WHERE post_id = $1::uuid AND media_position = $2`, [id, position]);
    // Close the gap (two steps: positions are unique).
    await client.query(`UPDATE marketing_post_media SET position = position + 1000 WHERE post_id = $1::uuid AND position > $2`, [id, position]);
    await client.query(`UPDATE marketing_post_media SET position = position - 1001 WHERE post_id = $1::uuid AND position > 1000`, [id]);
    await client.query(`UPDATE marketing_post_tags SET media_position = media_position - 1 WHERE post_id = $1::uuid AND media_position > $2`, [id, position]);
    await settle(client, id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  return NextResponse.json({ post });
}

const orderSchema = z.object({ order: z.array(z.number().int().min(0)).min(1).max(MAX_ITEMS) }).strict();

async function PATCH_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  const parsed = orderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send the new order as a list of positions" }, { status: 400 });
  const order = parsed.data.order;
  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    const why = await editable(client, g.session.tid, id);
    if (why) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: why }, { status: why === "Post not found" ? 404 : 409 });
    }
    const have = await client.query<{ position: number }>(`SELECT position FROM marketing_post_media WHERE post_id = $1::uuid ORDER BY position`, [id]);
    const cur = have.rows.map((r) => r.position);
    if (order.length !== cur.length || [...order].sort((a, b) => a - b).join() !== cur.join()) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "The order must list every picture once" }, { status: 400 });
    }
    for (const [to, from] of order.entries()) {
      await client.query(`UPDATE marketing_post_media SET position = $3 + 1000 WHERE post_id = $1::uuid AND position = $2`, [id, from, to]);
      await client.query(`UPDATE marketing_post_tags SET media_position = $3 + 1000 WHERE post_id = $1::uuid AND media_position = $2`, [id, from, to]);
    }
    await client.query(`UPDATE marketing_post_media SET position = position - 1000 WHERE post_id = $1::uuid AND position >= 1000`, [id]);
    await client.query(`UPDATE marketing_post_tags SET media_position = media_position - 1000 WHERE post_id = $1::uuid AND media_position >= 1000`, [id]);
    await settle(client, id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  return NextResponse.json({ post });
}

export const POST = withActivity("marketing/posts/[id]/media", POST_handler);
export const DELETE = withActivity("marketing/posts/[id]/media", DELETE_handler);
export const PATCH = withActivity("marketing/posts/[id]/media", PATCH_handler);
