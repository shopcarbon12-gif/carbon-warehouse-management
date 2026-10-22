/**
 * GET /api/storefront/meta-feed — the Meta catalog's supplementary feed (CSV):
 * one row per Shopify variant that has a front close-up, giving it that
 * close-up as its ad picture. Built by the worker (lib/server/meta-feed.ts).
 *
 * Public (proxy.ts): Meta fetches it on a schedule with no WMS session, and it
 * carries only product photos that are already public on shopcarbon.com.
 */
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { resolvePublicAppOrigin } from "@/lib/resolvePublicAppOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const pool = getPool();
  if (!pool) return new Response("Database unavailable", { status: 503 });
  const r = await pool.query<{ variant_id: string; src: string }>(`SELECT variant_id, src FROM meta_feed_rows ORDER BY variant_id`);
  // The address changes only when the picture does, so Meta re-downloads only those.
  const tag = (src: string) => createHash("sha1").update(src).digest("hex").slice(0, 12);
  const base = `${resolvePublicAppOrigin(req)}/api/storefront/meta-feed/image`;
  const lines = ["id,image_link", ...r.rows.map((x) => `${x.variant_id},${base}?v=${x.variant_id}&t=${tag(x.src)}`)];
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "public, max-age=900" },
  });
}
