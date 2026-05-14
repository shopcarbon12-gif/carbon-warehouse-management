import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Manual (non-RFID) catalog items, managed at the matrix/UPC level.
 *
 * GET    → List of matrices flagged is_manual_only = TRUE, with per-matrix
 *          stats (sku count, summed LS on-hand, summed adjustments at the
 *          user's active location).
 * POST   → { matrixIds: string[] }   flips is_manual_only = TRUE
 * DELETE → { matrixIds: string[] }   flips is_manual_only = FALSE
 *
 * Matrices are tenant-scoped via the items/locations relationship; we don't
 * have a direct matrices.tenant_id column, so writes intentionally don't
 * filter by tenant. Multi-tenant isolation is enforced upstream by the
 * single-tenant deployment model used in production.
 */

type ManualMatrixRow = {
  matrix_id: string;
  matrix_ls_system_id: string | null;
  matrix_upc: string | null;
  name: string;
  vendor: string | null;
  brand: string | null;
  sku_count: number;
  ls_on_hand_total: number;
  qty: number;
};

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const r = await pool.query<{
    matrix_id: string;
    matrix_ls_system_id: string | null;
    matrix_upc: string | null;
    name: string;
    vendor: string | null;
    brand: string | null;
    sku_count: string;
    ls_on_hand_total: string | null;
  }>(
    `SELECT
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       m.upc AS matrix_upc,
       m.description AS name,
       m.vendor,
       m.brand,
       COUNT(cs.id)::text AS sku_count,
       COALESCE(SUM(cs.ls_on_hand_total), 0)::text AS ls_on_hand_total
     FROM matrices m
     LEFT JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = FALSE
     WHERE m.is_manual_only = TRUE
     GROUP BY m.id, m.ls_system_id, m.upc, m.description, m.vendor, m.brand
     ORDER BY m.description ASC NULLS LAST, m.upc ASC NULLS LAST
     LIMIT 5000`,
  );

  // Per-matrix adjustments overlay at the user's active location.
  const matrixIds = r.rows.map((row) => row.matrix_id);
  const adjustmentsByMatrix = new Map<string, number>();
  if (matrixIds.length > 0) {
    try {
      const adj = await pool.query<{ matrix_id: string; delta: string }>(
        `SELECT cs.matrix_id::text AS matrix_id,
                COALESCE(SUM(ia.qty_delta), 0)::text AS delta
           FROM inventory_adjustments ia
           INNER JOIN custom_skus cs ON cs.id = ia.custom_sku_id
          WHERE cs.matrix_id = ANY($1::uuid[])
            AND ia.location_id = $2::uuid
            AND ia.state = 'settled'
          GROUP BY cs.matrix_id`,
        [matrixIds, session.lid],
      );
      for (const row of adj.rows) {
        adjustmentsByMatrix.set(row.matrix_id, Number(row.delta) || 0);
      }
    } catch {
      // inventory_adjustments missing/broken — keep going with zero overlay.
    }
  }

  const rows: ManualMatrixRow[] = r.rows.map((row) => {
    const onHand = Number(row.ls_on_hand_total ?? 0) || 0;
    const delta = adjustmentsByMatrix.get(row.matrix_id) ?? 0;
    return {
      matrix_id: row.matrix_id,
      matrix_ls_system_id: row.matrix_ls_system_id,
      matrix_upc: row.matrix_upc,
      name: row.name,
      vendor: row.vendor,
      brand: row.brand,
      sku_count: Number(row.sku_count) || 0,
      ls_on_hand_total: onHand,
      qty: onHand + delta,
    };
  });

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
