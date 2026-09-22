import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { reorderShopifyVariants } from "@/lib/server/shopify-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** custom_sku ids, first to last, exactly as the operator dragged them. */
  ids: z.array(z.string().uuid()).min(1).max(500),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Persist the manual variant order for a matrix and mirror it to Shopify.
 *
 * The grid shows sizes in wearing order on its own (lib/size-order.ts); this is
 * for the products that want an order of their own. Every row of the matrix is
 * rewritten in one statement, so a matrix is never half-ordered.
 *
 * Shopify is updated in the same request rather than waiting for the next
 * publish: the operator dragged rows and pressed Save, so the storefront should
 * match. A Shopify failure does not fail the save — the order is already stored,
 * and the next Check & Publish carries it — but it is reported back.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid matrix id" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { ids } = parsed.data;

  const client = await pool.connect();
  let ordered = 0;
  try {
    await client.query("BEGIN");
    // Position by array index. Scoped to this matrix so a stray id from another
    // product cannot be renumbered here.
    const r = await client.query(
      `UPDATE custom_skus cs
          SET sort_order = pos.ord
         FROM (SELECT id::uuid AS id, ordinality::int - 1 AS ord
                 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)) AS pos
        WHERE cs.id = pos.id AND cs.matrix_id = $1::uuid`,
      [id, ids],
    );
    ordered = r.rowCount ?? 0;
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[variant-order PUT]", e);
    return NextResponse.json({ error: "Could not save the order" }, { status: 500 });
  } finally {
    client.release();
  }

  let shopify: string | null = null;
  try {
    shopify = await reorderShopifyVariants(pool, id);
  } catch (e) {
    console.error("[variant-order PUT shopify]", e);
    shopify = e instanceof Error ? `Shopify not updated: ${e.message}` : "Shopify not updated";
  }

  return NextResponse.json({ ok: true, ordered, shopify });
}
