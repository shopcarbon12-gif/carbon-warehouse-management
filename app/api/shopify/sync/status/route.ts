import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { normalizeShopDomain, getShopifyAdminToken } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shopify picture-sync status for the Settings → Shopify tab. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || "");
  const connected = Boolean(shop && getShopifyAdminToken(shop || ""));

  const m = await pool.query<{ total: number; with_pictures: number; last: Date | null }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE jsonb_array_length(shopify_image_urls) > 0)::int AS with_pictures,
            MAX(shopify_images_synced_at) AS last
       FROM matrices`,
  );
  const cs = await pool.query<{ total: number; with_picture: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE shopify_image_url IS NOT NULL)::int AS with_picture
       FROM custom_skus`,
  );
  const active = await pool.query<{ id: string }>(
    `SELECT id::text FROM sync_jobs
      WHERE job_type = 'shopify_image_sync' AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`,
  );

  return NextResponse.json(
    {
      connected,
      store: shop ?? null,
      matrices_total: m.rows[0]?.total ?? 0,
      matrices_with_pictures: m.rows[0]?.with_pictures ?? 0,
      skus_total: cs.rows[0]?.total ?? 0,
      skus_with_picture: cs.rows[0]?.with_picture ?? 0,
      last_synced_at: m.rows[0]?.last ? m.rows[0].last.toISOString() : null,
      active_job_id: active.rows[0]?.id ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
