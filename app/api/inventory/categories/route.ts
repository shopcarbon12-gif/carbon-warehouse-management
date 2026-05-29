import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Catalog categories overview. Aggregates matrices by `category` with the
 * subcategories under each and counts of styles (matrices) and variants
 * (non-archived custom_skus). Read-only first cut for /inventory/categories.
 */

type CategoryRow = {
  name: string;
  matrix_count: number;
  variant_count: number;
  subcategories: string[];
};

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const r = await pool.query<{
    name: string;
    matrix_count: string;
    variant_count: string;
    subcategories: unknown;
  }>(
    `SELECT
       m.category                         AS name,
       COUNT(DISTINCT m.id)::text         AS matrix_count,
       COUNT(cs.id)::text                 AS variant_count,
       COALESCE(
         json_agg(DISTINCT m.subcategory_1)
           FILTER (WHERE m.subcategory_1 IS NOT NULL AND trim(m.subcategory_1) <> ''),
         '[]'::json
       )                                  AS subcategories
     FROM matrices m
     LEFT JOIN custom_skus cs ON cs.matrix_id = m.id AND cs.archived = FALSE
     WHERE m.category IS NOT NULL AND trim(m.category) <> ''
     GROUP BY m.category
     ORDER BY m.category ASC`,
  );

  const rows: CategoryRow[] = r.rows.map((row) => ({
    name: row.name,
    matrix_count: Number(row.matrix_count) || 0,
    variant_count: Number(row.variant_count) || 0,
    subcategories: Array.isArray(row.subcategories)
      ? (row.subcategories as string[]).slice().sort((a, b) => a.localeCompare(b))
      : [],
  }));

  return NextResponse.json({ categories: rows }, { headers: { "Cache-Control": "no-store" } });
}
