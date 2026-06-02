import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The "sizes available" run (box 8) for a SKU's style — every distinct size in
 * the same matrix, exactly what commission feeds the printed tag. Used so the
 * label preview's box 8 shows the real size run (e.g. "30 32 34" for jeans)
 * instead of a default placeholder. Returns the raw joined string; the
 * preview's normalizeSizesColumn() dedupes/orders it like the print does.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("customSkuId")?.trim();
  if (!id) return NextResponse.json({ sizesAvailable: "" });

  const pool = getPool();
  if (!pool) return NextResponse.json({ sizesAvailable: "" });

  try {
    const r = await pool.query<{ size: string | null }>(
      `SELECT DISTINCT cs.size
         FROM custom_skus cs
        WHERE cs.matrix_id = (SELECT matrix_id FROM custom_skus WHERE id = $1::uuid)
          AND cs.archived = false
          AND cs.size IS NOT NULL
        ORDER BY cs.size`,
      [id],
    );
    const sizesAvailable = r.rows
      .map((x) => (x.size ?? "").trim())
      .filter(Boolean)
      .join(", ");
    return NextResponse.json({ sizesAvailable }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ sizesAvailable: "" });
  }
}
