import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { enqueueSeoFull } from "@/lib/server/seo-full";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Apply a colour rename the full SEO pass suggested (owner clicks "Apply" in
 * the SEO tab). Same path as the Nov 2026 catalog pass:
 *   1. rename the colour on the matrix's SKUs (+ Studio colour runs) in the WMS,
 *      and on every other piece of the same set that carries that colour —
 *      set pieces pair by colour, so they must keep the same name;
 *   2. queue a Shopify publish for each renamed matrix;
 *   3. queue a full SEO run after it (the worker takes jobs oldest first), which
 *      rewrites copy/alts with the new name, translates it and re-links photos.
 * Body: { matrixId, from, to }.
 */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { matrixId?: string; from?: string; to?: string };
  const matrixId = String(body.matrixId || "");
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim().toUpperCase();
  if (!/^[0-9a-f-]{36}$/i.test(matrixId) || !from || !to) return NextResponse.json({ error: "matrixId, from and to are required" }, { status: 400 });
  if (!/^[A-Z0-9 &/'-]{2,40}$/.test(to)) return NextResponse.json({ error: "The new colour must be a plain upper-case name." }, { status: 400 });

  const m = await pool.query<{ id: string; set_group_id: string | null; shopify_product_id: string | null }>(
    `SELECT id::text, set_group_id::text, shopify_product_id FROM matrices WHERE id=$1::uuid`,
    [matrixId],
  );
  const row = m.rows[0];
  if (!row?.shopify_product_id) return NextResponse.json({ error: "Product not on Shopify." }, { status: 400 });

  /* The product itself + set partners that sell the same colour. */
  const group = row.set_group_id
    ? (await pool.query<{ id: string; shopify_product_id: string | null }>(
        `SELECT m.id::text, m.shopify_product_id FROM matrices m
          WHERE m.set_group_id = $1::uuid
            AND EXISTS (SELECT 1 FROM custom_skus cs WHERE cs.matrix_id = m.id AND cs.color_code = $2)`,
        [row.set_group_id, from],
      )).rows
    : [{ id: row.id, shopify_product_id: row.shopify_product_id }];
  if (!group.some((g) => g.id === matrixId)) group.push({ id: row.id, shopify_product_id: row.shopify_product_id });

  const clash = await pool.query(`SELECT 1 FROM custom_skus WHERE matrix_id = ANY($1::uuid[]) AND color_code = $2 LIMIT 1`, [group.map((g) => g.id), to]);
  if (clash.rowCount) return NextResponse.json({ error: `${to} is already a colour of this product.` }, { status: 409 });

  const c = await pool.connect();
  const renamed: { matrixId: string; skus: number; pushJob: string }[] = [];
  try {
    await c.query("BEGIN");
    for (const g of group) {
      const u = await c.query(`UPDATE custom_skus SET color_code=$3 WHERE matrix_id=$1::uuid AND color_code=$2`, [g.id, from, to]);
      if (!u.rowCount) continue;
      await c.query(`UPDATE studio_color_runs SET color=$3 WHERE matrix_id=$1::uuid AND color=$2`, [g.id, from, to]);
      await c.query(`UPDATE matrices SET shopify_sync_status='pending' WHERE id=$1::uuid`, [g.id]);
      const j = await c.query<{ id: string }>(
        `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
         VALUES ($1::uuid, $2::uuid, 'shopify_product_push', 'queued', $3, $4::jsonb) RETURNING id::text`,
        [session.tid, session.lid, `shopify_product_push:${g.id}:${Date.now()}`, JSON.stringify({ matrixId: g.id, locationId: session.lid, trigger: "seo_colour_rename", from, to })],
      );
      renamed.push({ matrixId: g.id, skus: u.rowCount ?? 0, pushJob: j.rows[0].id });
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    return NextResponse.json({ error: e instanceof Error ? e.message : "Rename failed" }, { status: 500 });
  } finally {
    c.release();
  }
  if (!renamed.length) return NextResponse.json({ error: `No SKU is coloured ${from}.` }, { status: 404 });

  /* Queued after the publishes, so the worker runs them first. */
  const seo = [];
  for (const g of group) {
    if (!g.shopify_product_id || !renamed.some((r) => r.matrixId === g.id)) continue;
    seo.push(await enqueueSeoFull(pool, { tenantId: session.tid, locationId: session.lid, productId: g.shopify_product_id, matrixId: g.id, trigger: "colour" }));
  }
  return NextResponse.json({ ok: true, from, to, renamed, seo });
}

export const POST = withActivity("shopify/seo/full/colour", POST_handler);
