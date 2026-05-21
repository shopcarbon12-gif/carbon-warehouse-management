import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Typeahead for the Shelf Map "Add item to bin" combo. Returns up to 30
 * distinct (sku_prefix, name, color) groups matching the query.
 *
 * sku_prefix uses the project's existing rule:
 *   - C-prefixed SKUs: LEFT(sku, 11)
 *   - everything else: LEFT(sku, 9)
 *
 * Search hits any of: sku_prefix, matrix description (name), color_code.
 * GET /api/overview/locations/sku-search?q=<term>
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const like = `%${q.replace(/[\\%_]/g, (s) => `\\${s}`)}%`;

  try {
    const r = await pool.query<{
      sku_prefix: string;
      name: string | null;
      color: string | null;
    }>(
      `SELECT DISTINCT
         CASE WHEN cs.sku LIKE 'C%' THEN LEFT(cs.sku, 11) ELSE LEFT(cs.sku, 9) END AS sku_prefix,
         REGEXP_REPLACE(m.description, '\\s+\\S+$', '') AS name,
         cs.color_code AS color
       FROM custom_skus cs
       INNER JOIN matrices m ON m.id = cs.matrix_id
       WHERE cs.archived = FALSE
         AND (
           cs.sku ILIKE $1 ESCAPE '\\'
           OR m.description ILIKE $1 ESCAPE '\\'
           OR cs.color_code ILIKE $1 ESCAPE '\\'
         )
       ORDER BY name NULLS LAST, sku_prefix
       LIMIT 30`,
      [like],
    );
    return NextResponse.json(
      { rows: r.rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[overview/locations/sku-search]", e);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
