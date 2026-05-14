import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  applyManualItemOverride,
  lookupUserNameForHistory,
} from "@/lib/server/manual-item-qty";

/**
 * POST /api/inventory/catalog/manual-items/[customSkuId]/override
 *
 * Direct admin override of a manual item's qty at the user's active location.
 * Writes manual_item_qty.current_qty (replaces, not adds) AND appends one
 * manual_item_qty_history row, source = 'manual_override', attributed to
 * the calling user.
 *
 * Used by the "Adjust quantity" action inside the Item History modal.
 * Cycle count Finish, LS sync, POS, transfers all call applyManualItemOverride
 * directly with their own source values — they don't go through this endpoint.
 */

const bodySchema = z.object({
  newQty: z.number().int().min(0).max(999_999),
  notes: z.string().trim().max(500).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ customSkuId: string }> },
) {
  const { customSkuId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(customSkuId)) {
    return NextResponse.json({ error: "Invalid customSkuId" }, { status: 400 });
  }

  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  /* Confirm the SKU exists, belongs to the user's tenant, and that its
   * matrix is actually flagged manual. Prevents writing manual-item rows
   * for RFID SKUs (which would never be read back by the catalog query). */
  const sku = await pool.query<{ matrix_id: string; is_manual_only: boolean }>(
    `SELECT cs.matrix_id::text, COALESCE(m.is_manual_only, FALSE) AS is_manual_only
       FROM custom_skus cs
       INNER JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.id = $1::uuid
      LIMIT 1`,
    [customSkuId],
  );
  if (sku.rowCount === 0) {
    return NextResponse.json({ error: "SKU not found" }, { status: 404 });
  }
  if (!sku.rows[0]?.is_manual_only) {
    return NextResponse.json(
      { error: "SKU is not a manual item (its UPC isn't marked manual)" },
      { status: 409 },
    );
  }

  const userName = await lookupUserNameForHistory(pool, session.sub);
  const result = await applyManualItemOverride(pool, {
    customSkuId,
    locationId: session.lid,
    newQty: parsed.data.newQty,
    source: "manual_override",
    changedByUserId: session.sub,
    changedByUserName: userName,
    notes: parsed.data.notes ?? null,
  });

  return NextResponse.json({
    ok: true,
    previousQty: result.previousQty,
    newQty: result.newQty,
    deltaQty: result.deltaQty,
    historyId: result.historyId,
  });
}
