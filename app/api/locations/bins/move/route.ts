import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { assignSkuGroupToBin } from "@/lib/server/shelf-map";

const Body = z.object({
  /** SKU prefix to move — LEFT(cs.sku, 11) for C-prefixed, LEFT(cs.sku, 9) otherwise. */
  skuPrefix: z.string().trim().min(1).max(32),
  /**
   * The product. Required in practice — two matrices can share a UPC, so the
   * prefix alone would sweep the twin product along. Optional only so older
   * clients keep working.
   */
  matrixId: z.string().uuid().nullish(),
  /** UUID of the source bin, `null` = homeless, or `"any"` = anywhere. */
  sourceBinId: z.union([z.string().uuid(), z.literal("any"), z.null()]),
  /** UUID of the target bin. */
  targetBinId: z.string().uuid(),
  /** `"move"` = this bin only (default). `"add"` = also list it here (multi-bin). */
  mode: z.enum(["move", "add"]).optional(),
});

/**
 * Put every in-stock EPC of one product's (UPC + colour) group into a bin.
 * Sweeps all sizes of that colour — that's the operator's mental model: a
 * colour goes on a shelf as a unit. `mode: "add"` keeps the group's existing
 * bins and lists this one alongside them; there is no cap on bins per EPC.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Same gate as the existing Clean flow — moving items between bins is an
  // admin/manager action; warehouse-floor users can't reorganize bins.
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await assignSkuGroupToBin(
      client,
      session.tid,
      session.lid,
      parsed.data,
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, moved: result.moved });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    const msg = e instanceof Error ? e.message : "Move failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[locations/bins/move POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
