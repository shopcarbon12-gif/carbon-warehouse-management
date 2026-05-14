import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * GET /api/inventory/catalog/manual-items/[customSkuId]/history
 *
 * Item History modal — returns the full override history for a single
 * manual SKU at the user's active location, newest first. Each row carries
 * source / from→to / delta / when / who, and (for transfer sources) the
 * slip number + from/to locations.
 */

const MAX_ROWS = 500;

export async function GET(
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

  const meta = await pool.query<{
    sku: string;
    color: string | null;
    size: string | null;
    matrix_upc: string | null;
    matrix_name: string;
    is_manual_only: boolean;
    current_qty: number | null;
  }>(
    `SELECT cs.sku,
            cs.color_code AS color,
            cs.size,
            m.upc AS matrix_upc,
            m.description AS matrix_name,
            COALESCE(m.is_manual_only, FALSE) AS is_manual_only,
            (SELECT current_qty FROM manual_item_qty miq
              WHERE miq.custom_sku_id = cs.id
                AND miq.location_id = $2::uuid) AS current_qty
       FROM custom_skus cs
       INNER JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.id = $1::uuid
      LIMIT 1`,
    [customSkuId, session.lid],
  );
  if (meta.rowCount === 0) {
    return NextResponse.json({ error: "SKU not found" }, { status: 404 });
  }

  const r = await pool.query<{
    id: string;
    source: string;
    previous_qty: number | null;
    new_qty: number;
    delta_qty: number | null;
    changed_by_user_id: string | null;
    changed_by_user_name: string | null;
    changed_at: string;
    transfer_slip_number: string | null;
    transfer_from_code: string | null;
    transfer_to_code: string | null;
    notes: string | null;
    reference_id: string | null;
  }>(
    `SELECT h.id::text,
            h.source,
            h.previous_qty,
            h.new_qty,
            h.delta_qty,
            h.changed_by_user_id::text AS changed_by_user_id,
            h.changed_by_user_name,
            h.changed_at,
            h.transfer_slip_number,
            lf.code AS transfer_from_code,
            lt.code AS transfer_to_code,
            h.notes,
            h.reference_id::text AS reference_id
       FROM manual_item_qty_history h
       LEFT JOIN locations lf ON lf.id = h.transfer_from_location_id
       LEFT JOIN locations lt ON lt.id = h.transfer_to_location_id
      WHERE h.custom_sku_id = $1::uuid
        AND h.location_id = $2::uuid
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT ${MAX_ROWS}`,
    [customSkuId, session.lid],
  );

  return NextResponse.json(
    {
      sku: {
        custom_sku_id: customSkuId,
        sku: meta.rows[0]!.sku,
        color: meta.rows[0]!.color,
        size: meta.rows[0]!.size,
        matrix_upc: meta.rows[0]!.matrix_upc,
        matrix_name: meta.rows[0]!.matrix_name,
        is_manual_only: meta.rows[0]!.is_manual_only,
        current_qty: meta.rows[0]!.current_qty == null ? 0 : Number(meta.rows[0]!.current_qty),
      },
      rows: r.rows.map((row) => ({
        id: row.id,
        source: row.source,
        previous_qty: row.previous_qty == null ? null : Number(row.previous_qty),
        new_qty: Number(row.new_qty),
        delta_qty: row.delta_qty == null ? null : Number(row.delta_qty),
        changed_by_user_id: row.changed_by_user_id,
        changed_by_user_name: row.changed_by_user_name,
        changed_at: row.changed_at,
        transfer_slip_number: row.transfer_slip_number,
        transfer_from_code: row.transfer_from_code,
        transfer_to_code: row.transfer_to_code,
        notes: row.notes,
        reference_id: row.reference_id,
      })),
      count: r.rowCount,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
