import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

type Row = {
  id: string;
  ls_system_id: string | null;
  description: string | null;
  sku: string;
};

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const customSku = new URL(req.url).searchParams.get("custom_sku")?.trim() ?? "";
  if (!customSku) {
    return NextResponse.json({ error: "Missing custom_sku" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const r = await pool.query<Row>(
      `SELECT
         cs.id,
         cs.ls_system_id::text AS ls_system_id,
         m.description,
         cs.sku
       FROM custom_skus cs
       LEFT JOIN matrices m ON m.id = cs.matrix_id
       WHERE LOWER(cs.sku) = LOWER($1::text)
       -- Duplicate SKU codes across an archived + active matrix (a Lightspeed
       -- replacement reusing the old UPC/SKU) must resolve to the ACTIVE row,
       -- else re-encode targets the archived item. Deterministic tiebreak on id.
       ORDER BY cs.archived ASC, cs.id ASC
       LIMIT 1`,
      [customSku],
    );

    const row = r.rows[0];
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json(
      {
        id: row.id,
        system_id: row.ls_system_id ? Number(row.ls_system_id) : null,
        name: row.description ?? "",
        custom_sku: row.sku,
        sku: row.sku,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[v1/catalog/items]", e);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
