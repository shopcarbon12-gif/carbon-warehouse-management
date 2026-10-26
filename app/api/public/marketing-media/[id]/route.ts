/**
 * GET /api/public/marketing-media/<media id>[.jpg|.mp4] — the picture or video
 * of a Social post, served from R2 so Instagram and Facebook can
 * fetch it when the post is published (they need a public URL; our R2 bucket
 * is private). Public (no session): the id is a random UUID per file and only
 * files that belong to a post are served.
 */
import { getPool } from "@/lib/db";
import { downloadStorageObject } from "@/lib/storageProvider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-cover)?(\.(jpg|jpeg|png|mp4))?$/i;

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  // TikTok's URL-prefix ownership file (Social → TikTok; lib/server/marketing/tiktok.ts).
  const vf = process.env.TIKTOK_VERIFY_FILENAME?.trim();
  if (vf && id === vf) return new Response(process.env.TIKTOK_VERIFY_CONTENT ?? "", { headers: { "Content-Type": "text/plain" } });
  const m = UUID_RE.exec(id);
  const pool = getPool();
  if (!m || !pool) return new Response("Not found", { status: 404 });
  const r = await pool.query<{ storage_path: string | null; cover_storage_path: string | null; kind: string }>(
    `SELECT storage_path, cover_storage_path, kind FROM marketing_post_media WHERE id = $1::uuid`,
    [m[1]],
  );
  const row = r.rows[0];
  // "<id>-cover.jpg": a Reel's cover picture.
  const path = m[2] ? row?.cover_storage_path : row?.storage_path;
  if (!row || !path) return new Response("Not found", { status: 404 });
  try {
    const obj = await downloadStorageObject(path);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.contentType || (row.kind === "video" && !m[2] ? "video/mp4" : "image/jpeg"),
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
