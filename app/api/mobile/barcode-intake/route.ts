import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    barcode: z.string().min(1).max(256),
    sku: z.string().min(1).max(256).optional(),
    customSkuId: z.string().uuid().optional(),
    qty: z.number().int().min(1).max(1_000_000),
    title: z.string().max(512).optional(),
  })
  .refine((b) => Boolean(b.customSkuId?.trim()) || Boolean(b.sku?.trim()), {
    message: "Provide sku or customSkuId",
  });

/**
 * Receiving line: bumps `custom_skus.ls_on_hand_total` (WMS on-hand counter) and writes `inventory_audit_logs`.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { barcode, sku, customSkuId, qty, title } = parsed.data;
  const bc = barcode.trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pick = await client.query<{ id: string; old_v: string; sku: string }>(
      customSkuId
        ? `SELECT id::text, COALESCE(ls_on_hand_total, 0)::text AS old_v, sku
           FROM custom_skus WHERE id = $1::uuid LIMIT 1`
        : `SELECT id::text, COALESCE(ls_on_hand_total, 0)::text AS old_v, sku
           FROM custom_skus WHERE sku = $1 ORDER BY id LIMIT 1`,
      customSkuId ? [customSkuId] : [sku!.trim()],
    );

    const row = pick.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Unknown SKU for this tenant catalog" }, { status: 404 });
    }

    const oldNum = Number.parseInt(row.old_v, 10);
    const oldSafe = Number.isFinite(oldNum) ? oldNum : 0;
    const newSafe = oldSafe + qty;

    await client.query(
      `UPDATE custom_skus SET ls_on_hand_total = $2::integer, ls_qty_synced_at = now() WHERE id = $1::uuid`,
      [row.id, newSafe],
    );

    await client.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id
       )
       VALUES ($1::uuid, 'ADJUSTMENT', 'SKU', $2, $3, $4, $5, NULL)`,
      [
        session.tid,
        row.sku,
        String(oldSafe),
        String(newSafe),
        `mobile_barcode_intake barcode=${bc} qty=${qty}${title ? ` title=${title.slice(0, 80)}` : ""}`,
      ],
    );

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      custom_sku_id: row.id,
      sku: row.sku,
      ls_on_hand_total_before: oldSafe,
      ls_on_hand_total_after: newSafe,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[mobile/barcode-intake]", e);
    return NextResponse.json({ error: "Receive failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
