import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kind: z.enum(["rfid", "non_rfid"]),
  epc: z.string().max(64).optional(),
  sku: z.string().max(128).optional(),
  itemName: z.string().max(256).optional(),
  qty: z.number().int().min(1).max(100000).optional(),
  template: z.string().max(128).optional(),
  printer: z.string().max(128).optional(),
  deviceId: z.string().max(256).optional(),
});

/**
 * POST /api/handheld/print-event — log a label print so it appears in the
 * Label Print report. Best-effort from the handheld; failures don't block
 * printing. Actor = the signed-in user.
 */
export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
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
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const d = parsed.data;
  try {
    await pool.query(
      `INSERT INTO print_events (
         tenant_id, location_id, kind, epc, sku, item_name, qty,
         template, printer, device_id, created_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid
       )`,
      [
        session.tid,
        session.lid,
        d.kind,
        d.epc ?? null,
        d.sku ?? null,
        d.itemName ?? null,
        d.qty ?? 1,
        d.template ?? null,
        d.printer ?? null,
        d.deviceId ?? null,
        session.sub,
      ],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[handheld/print-event]", e);
    return NextResponse.json({ error: "Log failed" }, { status: 500 });
  }
}
