import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Lightweight typeahead for the Non-RFID search box on Transfer Out.
 *
 * Matches across: matrix description, custom SKU code, custom-sku UPC,
 * matrix UPC, matrix vendor, custom_sku color, custom_sku size, ls_system_id.
 * Limit fixed at 10 — any heavier filtering should use the grid view instead.
 *
 * GET /api/inventory/catalog/search?q=<term>
 * Returns: { rows: [{ custom_sku_id, sku, name, color, size, upc, vendor, sku_ls_system_id }] }
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (q.length < 1) {
    return NextResponse.json({ rows: [] });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const like = `%${q.replace(/[\\%_]/g, (s) => `\\${s}`)}%`;

  try {
    const r = await pool.query<{
      custom_sku_id: string;
      sku: string;
      name: string | null;
      color: string | null;
      size: string | null;
      upc: string | null;
      vendor: string | null;
      sku_ls_system_id: string | null;
      archived: boolean;
    }>(
      // Archived items are included so EPC → system_id resolution stays
      // consistent with how the catalog sync mirrors archived-from-Lightspeed:
      // a SKU that's archived in LS still owns its tags. The UI tags each
      // archived row with a badge so operators can see at a glance.
      `SELECT
         cs.id::text AS custom_sku_id,
         cs.sku AS sku,
         m.description AS name,
         cs.color_code AS color,
         cs.size,
         COALESCE(cs.upc, m.upc) AS upc,
         m.vendor,
         cs.ls_system_id::text AS sku_ls_system_id,
         cs.archived AS archived
       FROM custom_skus cs
       INNER JOIN matrices m ON m.id = cs.matrix_id
       WHERE
           m.description ILIKE $1 ESCAPE '\\'
           OR cs.sku ILIKE $1 ESCAPE '\\'
           OR cs.upc ILIKE $1 ESCAPE '\\'
           OR m.upc ILIKE $1 ESCAPE '\\'
           OR m.vendor ILIKE $1 ESCAPE '\\'
           OR cs.color_code ILIKE $1 ESCAPE '\\'
           OR cs.size ILIKE $1 ESCAPE '\\'
           OR cs.ls_system_id::text = $2
       ORDER BY
         cs.archived ASC,
         CASE WHEN cs.sku ILIKE $1 ESCAPE '\\' THEN 0 ELSE 1 END,
         m.description NULLS LAST
       LIMIT 10`,
      [like, q],
    );
    return NextResponse.json(
      { rows: r.rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[inventory/catalog/search]", e);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
