import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Manual (non-RFID) catalog items, managed at the matrix/UPC level.
 *
 * GET    → List of matrices flagged is_manual_only = TRUE. Each row shows
 *          UPC, item name, brand, sku_count, retail_price (MIN across
 *          non-archived variants), bin (aggregated from any items rows
 *          that exist for these SKUs at this location), and the TOTAL qty
 *          summed from manual_item_qty.current_qty across every variant.
 * POST   → { matrixIds: string[] }   flips is_manual_only = TRUE
 * DELETE → { matrixIds: string[] }   flips is_manual_only = FALSE
 */

type ManualMatrixRow = {
  matrix_id: string;
  matrix_upc: string | null;
  name: string;
  brand: string | null;
  sku_count: number;
  retail_price: string | null;
  bin_location: string | null;
  qty: number;
};

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  /* qty is summed from manual_item_qty.current_qty across all non-archived
     variants under each matrix at the user's active location. Bin is
     aggregated from any items rows still attached (e.g. SKUs that had EPCs
     before being flipped to manual — operator may still want to know where
     they physically sit). Retail price = MIN(non-null) across variants. */
  const r = await pool.query<{
    matrix_id: string;
    matrix_upc: string | null;
    name: string;
    brand: string | null;
    sku_count: string;
    retail_price: string | null;
    bin_location: string | null;
    qty: string;
  }>(
    `SELECT
       m.id::text AS matrix_id,
       m.upc AS matrix_upc,
       m.description AS name,
       m.brand,
       COUNT(DISTINCT cs.id)::text AS sku_count,
       MIN(cs.retail_price)::text AS retail_price,
       (
         SELECT string_agg(DISTINCT b.code, ', ' ORDER BY b.code)
           FROM items i
           INNER JOIN custom_skus cs2 ON cs2.id = i.custom_sku_id
           INNER JOIN bins b ON b.id = i.bin_id
          WHERE cs2.matrix_id = m.id
            AND cs2.archived = FALSE
            AND i.location_id = $1::uuid
            AND i.bin_id IS NOT NULL
            AND b.archived_at IS NULL
       ) AS bin_location,
       COALESCE(
         (
           SELECT SUM(miq.current_qty)::text
             FROM manual_item_qty miq
             INNER JOIN custom_skus cs3 ON cs3.id = miq.custom_sku_id
            WHERE cs3.matrix_id = m.id
              AND cs3.archived = FALSE
              AND miq.location_id = $1::uuid
         ),
         '0'
       ) AS qty
     FROM matrices m
     LEFT JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = FALSE
     WHERE m.is_manual_only = TRUE
     GROUP BY m.id, m.upc, m.description, m.brand
     ORDER BY m.description ASC NULLS LAST, m.upc ASC NULLS LAST
     LIMIT 5000`,
    [session.lid],
  );

  const rows: ManualMatrixRow[] = r.rows.map((row) => ({
    matrix_id: row.matrix_id,
    matrix_upc: row.matrix_upc,
    name: row.name,
    brand: row.brand,
    sku_count: Number(row.sku_count) || 0,
    retail_price: row.retail_price,
    bin_location: row.bin_location,
    qty: Number(row.qty) || 0,
  }));

  return NextResponse.json(
    { rows, count: rows.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const bodySchema = z.object({
  matrixIds: z.array(z.string().uuid()).min(1).max(1000),
});

export async function POST(req: Request) {
  return setManualFlag(req, true);
}

export async function DELETE(req: Request) {
  return setManualFlag(req, false);
}

async function setManualFlag(req: Request, value: boolean) {
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

  const r = await pool.query(
    `UPDATE matrices
        SET is_manual_only = $1::boolean
      WHERE id = ANY($2::uuid[])`,
    [value, parsed.data.matrixIds],
  );

  return NextResponse.json({ updated: r.rowCount ?? 0 });
}
