import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Autocomplete used by the Manual Items modal's "Search to add" input.
 * Matches against matrix UPC/description/vendor/system_id AND against any
 * variant SKU/UPC/system_id under the matrix — but always collapses results
 * up to the matrix level. So if the operator types a SKU partial, they get
 * back the parent UPC/matrix to add (matches the user's spec: "if looking
 * for a sku or partial the results will shown the upc of it sku").
 *
 * Excludes matrices already flagged is_manual_only so the modal only shows
 * candidates the operator hasn't added yet.
 */

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 1) {
    return NextResponse.json({ rows: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const like = `%${q}%`;
  const r = await pool.query<{
    matrix_id: string;
    matrix_ls_system_id: string | null;
    matrix_upc: string | null;
    name: string;
    vendor: string | null;
    sku_count: string;
  }>(
    `SELECT
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       m.upc AS matrix_upc,
       m.description AS name,
       m.vendor,
       COUNT(cs.id)::text AS sku_count
     FROM matrices m
     INNER JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = FALSE
     WHERE COALESCE(m.is_manual_only, FALSE) = FALSE
       AND (
         COALESCE(m.upc, '') ILIKE $1
         OR COALESCE(m.description, '') ILIKE $1
         OR COALESCE(m.vendor, '') ILIKE $1
         OR COALESCE(m.ls_system_id::text, '') ILIKE $1
         OR EXISTS (
           SELECT 1 FROM custom_skus cs2
           WHERE cs2.matrix_id = m.id
             AND cs2.archived = FALSE
             AND (
               cs2.sku ILIKE $1
               OR COALESCE(cs2.upc, '') ILIKE $1
               OR COALESCE(cs2.ls_system_id::text, '') ILIKE $1
             )
         )
       )
     GROUP BY m.id, m.ls_system_id, m.upc, m.description, m.vendor
     ORDER BY m.description ASC NULLS LAST, m.upc ASC NULLS LAST
     LIMIT 50`,
    [like],
  );

  const rows = r.rows.map((row) => ({
    matrix_id: row.matrix_id,
    matrix_ls_system_id: row.matrix_ls_system_id,
    matrix_upc: row.matrix_upc,
    name: row.name,
    vendor: row.vendor,
    sku_count: Number(row.sku_count) || 0,
  }));

  return NextResponse.json(
    { rows, count: rows.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
