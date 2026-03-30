import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  barcode: z.string().min(1).max(256),
  sku: z.string().min(1).max(256),
  qty: z.number().int().min(1).max(1_000_000),
  title: z.string().max(512).optional(),
});

/**
 * Log a barcode receiving line from the mobile app (session Bearer or cookie).
 * Does not mutate inventory quantities yet — audit trail for reporting.
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

  const { barcode, sku, qty, title } = parsed.data;
  const newValue = JSON.stringify({ barcode: barcode.trim().toUpperCase(), qty, title: title ?? null });

  try {
    await pool.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id
       )
       VALUES ($1::uuid, 'BULK_IMPORT', 'SKU', $2, NULL, $3, 'mobile_barcode_intake', NULL)`,
      [session.tid, sku.trim(), newValue.slice(0, 512)],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[mobile/barcode-intake]", e);
    return NextResponse.json({ error: "Log failed" }, { status: 500 });
  }
}
