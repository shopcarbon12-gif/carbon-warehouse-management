/**
 * GET  /api/creative/products — step 1 "What are we promoting?": every active in-stock Shopify
 *      product, with suggestions (new drops, best sellers, slow movers to move) and each one's
 *      Product Twin state.
 * POST /api/creative/products {productId, action: build | confirm | rebuild} — build the twin (on
 *      tap, ≈ $0.80 once, cached forever) or confirm its cut-outs ✓.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body, kick } from "@/lib/server/creative/http";
import { inStockCatalog } from "@/lib/server/email/catalog";
import { bestSellers } from "@/lib/server/creative/ideas";
import { enqueue } from "@/lib/server/creative/jobs";
import { twinView, TWIN_COST_ESTIMATE } from "@/lib/server/creative/twin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const [cat, best, twins] = await Promise.all([
      inStockCatalog(),
      bestSellers(12).catch(() => []),
      g.pool.query(`SELECT * FROM creative_product_twins WHERE tenant_id = $1::uuid`, [g.session.tid]),
    ]);
    const tw = new Map(twins.rows.map((t) => [t.product_id, twinView(t)]));
    const bestTitles = new Map(best.map((b) => [b.title, b.n]));
    const products = cat.map((p, i) => ({ ...p, isNew: i < 16, sold30: bestTitles.get(p.title) ?? null, twin: tw.get(p.id) ?? null }));
    const slow = [...products].sort((a, b) => b.stock - a.stock).slice(0, 12).map((p) => p.id);
    return NextResponse.json({
      products,
      suggestions: {
        newDrops: products.filter((p) => p.isNew).slice(0, 12).map((p) => p.id),
        bestSellers: products.filter((p) => p.sold30).sort((a, b) => (b.sold30 ?? 0) - (a.sold30 ?? 0)).slice(0, 12).map((p) => p.id),
        slowMovers: slow,
      },
      twinCost: TWIN_COST_ESTIMATE,
    });
  } catch (e) {
    return fail(e);
  }
}

const schema = z.object({ productId: z.string().startsWith("gid://shopify/Product/"), action: z.enum(["build", "confirm", "rebuild"]) });

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const b = await body(req, schema);
    const tid = g.session.tid;
    if (b.action === "confirm") {
      await g.pool.query(`UPDATE creative_product_twins SET status = 'confirmed', confirmed_at = now(), confirmed_by = $3 WHERE tenant_id = $1::uuid AND product_id = $2`, [tid, b.productId, g.session.email ?? null]);
      return NextResponse.json({ ok: true });
    }
    if (b.action === "rebuild") await g.pool.query(`DELETE FROM creative_product_twins WHERE tenant_id = $1::uuid AND product_id = $2`, [tid, b.productId]);
    await enqueue(g.pool, tid, "twin_build", { productId: b.productId }, { requestedBy: g.session.email ?? null, progress: "Building the product twin" });
    kick(g.pool, tid);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/products", POST_handler);
