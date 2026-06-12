import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sku: string }> };

/**
 * DELETE /api/locations/bins/:binCodeOrId/sku/:skuPrefix
 *
 * Removes one custom-SKU (matrix+colour prefix, all sizes) from a bin —
 * the inverse of the putaway assign. Used by the Bin Assign screen's
 * remove / undo action. Pre-existing bug: the mobile called this path but
 * no route existed, so every remove returned 404.
 *
 * `:id` accepts EITHER the bin UUID or the bin CODE (mobile ships the dashed
 * display code, e.g. "1-A-01-L"); we normalise both sides like the putaway
 * endpoints. `:skuPrefix` is the matrix+colour prefix (e.g. 122224804) — we
 * match every size via `sku LIKE '<prefix>%'`, the same filter the assign uses.
 *
 * Effect: in-stock items of that SKU whose PRIMARY bin is this bin become
 * homeless (bin_id = NULL); items that merely list this bin in
 * additional_bin_ids just drop it from that array. Active-location scoped.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, sku } = await ctx.params;
  const binKey = (id ?? "").trim();
  const skuPrefix = (sku ?? "").trim();
  if (!binKey) return NextResponse.json({ error: "Missing bin" }, { status: 400 });
  // Matrix/colour prefix range — same guard as the clean-bin endpoint.
  if (!/^[A-Za-z0-9]{7,32}$/.test(skuPrefix)) {
    return NextResponse.json({ error: "Invalid SKU" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Resolve the bin by UUID or normalised code, scoped to the active location.
  const bin = await pool.query<{ id: string }>(
    `SELECT id::text FROM bins
       WHERE location_id = $1::uuid
         AND archived_at IS NULL
         AND (
           id::text = $2
           OR regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
              = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
         )
       LIMIT 1`,
    [session.lid, binKey],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return NextResponse.json({ error: "Bin not found" }, { status: 404 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 1. Items whose PRIMARY home is this bin → homeless.
    const primary = await client.query(
      `UPDATE items
         SET bin_id = NULL
       WHERE location_id = $1::uuid
         AND status IN ('in-stock', 'pending_visibility')
         AND bin_id = $2::uuid
         AND custom_sku_id IN (SELECT id FROM custom_skus WHERE sku LIKE $3)`,
      [session.lid, binId, `${skuPrefix}%`],
    );
    // 2. Items that merely list this bin as an additional (multi-bin) home.
    const secondary = await client.query(
      `UPDATE items
         SET additional_bin_ids = array_remove(additional_bin_ids, $2::uuid)
       WHERE location_id = $1::uuid
         AND status IN ('in-stock', 'pending_visibility')
         AND $2::uuid = ANY(additional_bin_ids)
         AND custom_sku_id IN (SELECT id FROM custom_skus WHERE sku LIKE $3)`,
      [session.lid, binId, `${skuPrefix}%`],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      removed: (primary.rowCount ?? 0) + (secondary.rowCount ?? 0),
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[bins/:id/sku/:sku DELETE]", e);
    return NextResponse.json({ error: "Remove failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
