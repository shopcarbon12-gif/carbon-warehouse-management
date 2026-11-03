/**
 * GET /api/storefront/meta-feed — the Meta catalog's supplementary feed (CSV):
 * one row per Shopify variant. Its main picture is its colour's front close-up
 * (else Shopify's own), and the rest of the colour's photos follow as
 * additional pictures for the Facebook / Instagram Shop. Built by the worker
 * (lib/server/meta-feed.ts).
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
  const r = await pool.query<{ variant_id: string; src: string | null; main: string | null; gallery: string[] }>(
    `SELECT variant_id, src, main, gallery FROM meta_feed_rows ORDER BY variant_id`,
  );
  // The address changes only when the picture (or how it is squared) does, so Meta
  // re-downloads only those. "fit:" since the whole photo replaced the centre crop.
  const tag = (src: string) => createHash("sha1").update(`fit:${src}`).digest("hex").slice(0, 12);
  const base = `${resolvePublicAppOrigin(req)}/api/storefront/meta-feed/image`;
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    "id,image_link,additional_image_link",
    ...r.rows
      .filter((x) => x.src || x.main)
      .map((x) =>
        [x.variant_id, x.src ? `${base}?v=${x.variant_id}&t=${tag(x.src)}` : x.main!, x.gallery.join(",")].map(cell).join(","),
      ),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "public, max-age=900" },
  });
}
