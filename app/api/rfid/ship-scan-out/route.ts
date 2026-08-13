import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ship / scan-out — the operator scans the tag of the item being shipped to the
 * customer; that exact EPC flips to `sold`. Accepts an in-stock OR unknown tag
 * (the sale may already have tentatively marked one unknown). The EPC value is
 * never touched — status change only. Returns the item so the UI can confirm.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { epc?: string };
  const epc = String(body.epc ?? "").replace(/\s/g, "").toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(epc)) {
    return NextResponse.json({ ok: false, error: "Invalid EPC." }, { status: 400 });
  }

  const upd = await pool.query<{ id: string; custom_sku_id: string | null }>(
    `UPDATE items SET status = 'sold', last_seen_at = now()
      WHERE epc = $1 AND status IN ('in-stock', 'unknown')
      RETURNING id::text, custom_sku_id::text`,
    [epc],
  );

  if (upd.rowCount === 0) {
    const cur = await pool.query<{ status: string }>(`SELECT status FROM items WHERE epc = $1`, [epc]);
    const status = cur.rows[0]?.status ?? null;
    return NextResponse.json({
      ok: false,
      epc,
      status,
      error: status === "sold" ? "Already shipped (sold)." : status ? `Tag is '${status}', not shippable.` : "EPC not found.",
    });
  }

  // Resolve display info.
  const info = await pool.query<{ sku: string; name: string; color: string | null; size: string | null }>(
    `SELECT cs.sku, m.description AS name, cs.color_code AS color, cs.size
       FROM items i JOIN custom_skus cs ON cs.id = i.custom_sku_id JOIN matrices m ON m.id = cs.matrix_id
      WHERE i.epc = $1`,
    [epc],
  );
  const row = info.rows[0];
  return NextResponse.json({
    ok: true,
    epc,
    sku: row?.sku ?? null,
    name: row?.name ?? null,
    color: row?.color ?? null,
    size: row?.size ?? null,
  });
}
