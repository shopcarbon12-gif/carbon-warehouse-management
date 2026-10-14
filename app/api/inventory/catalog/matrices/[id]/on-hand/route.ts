import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Qty on hand for every variant of one matrix (archived included) at the
 * operator's active location — the numbers beside each SKU in the Matrix
 * window. Same semantics as the catalog grid (lib/server/inventory-catalog.ts):
 * RFID matrices count Live ('in-stock') EPCs; manual-only matrices use
 * manual_item_qty.
 *
 * Kept off the matrix GET on purpose: the Matrix window re-seeds its unsaved
 * draft whenever that payload changes, so a qty refresh riding on it would
 * throw away edits.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid matrix id" }, { status: 400 });
  }

  const m = await pool.query<{ is_manual_only: boolean }>(
    `SELECT COALESCE(is_manual_only, FALSE) AS is_manual_only FROM matrices WHERE id = $1::uuid`,
    [id],
  );
  if (m.rowCount === 0) {
    return NextResponse.json({ error: "Matrix not found" }, { status: 404 });
  }
  const isManualOnly = m.rows[0].is_manual_only === true;

  const r = await pool.query<{ custom_sku_id: string; live_epcs: number; manual_qty: number | null }>(
    `SELECT
       cs.id::text AS custom_sku_id,
       (
         SELECT COUNT(*)::int
         FROM items i
         WHERE i.custom_sku_id = cs.id
           AND i.location_id   = $2::uuid
           AND i.status        = 'in-stock'
       ) AS live_epcs,
       (
         SELECT miq.current_qty
         FROM manual_item_qty miq
         WHERE miq.custom_sku_id = cs.id
           AND miq.location_id   = $2::uuid
       ) AS manual_qty
     FROM custom_skus cs
     WHERE cs.matrix_id = $1::uuid`,
    [id, session.lid],
  );

  const rows = r.rows.map((row) => {
    const manualQty = row.manual_qty == null ? null : Number(row.manual_qty);
    const liveEpcs = Number(row.live_epcs) || 0;
    return {
      custom_sku_id: row.custom_sku_id,
      on_hand: isManualOnly ? (manualQty ?? 0) : liveEpcs,
      live_epcs: liveEpcs,
      manual_qty: manualQty,
    };
  });

  return NextResponse.json({ is_manual_only: isManualOnly, rows });
}
