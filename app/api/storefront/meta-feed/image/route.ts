/**
 * GET /api/storefront/meta-feed/image?v=<variant id> — that variant's front
 * close-up (from meta_feed_rows), cropped to a 1080 px square for Meta's
 * catalog ad cards. Only photos already chosen for the feed are served, so this
 * is not an open image proxy.
 *
 * Public (proxy.ts): Meta downloads the pictures with no WMS session.
 */
import sharp from "sharp";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZE = 1080;
const cache = new Map<string, Buffer>();

async function square(src: string): Promise<Buffer> {
  const hit = cache.get(src);
  if (hit) return hit;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`photo ${res.status}`);
  const out = await sharp(Buffer.from(await res.arrayBuffer()))
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
  if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
  cache.set(src, out);
  return out;
}

export async function GET(req: Request) {
  const v = new URL(req.url).searchParams.get("v") || "";
  if (!/^\d{1,20}$/.test(v)) return new Response("Not found", { status: 404 });
  const pool = getPool();
  if (!pool) return new Response("Database unavailable", { status: 503 });
  const r = await pool.query<{ src: string }>(`SELECT src FROM meta_feed_rows WHERE variant_id = $1`, [v]);
  const src = r.rows[0]?.src;
  if (!src || !src.startsWith("https://cdn.shopify.com/")) return new Response("Not found", { status: 404 });
  try {
    const body = await square(src);
    return new Response(new Uint8Array(body), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return new Response("Photo unavailable", { status: 502 });
  }
}
