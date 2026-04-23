import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

const bodySchema = z.object({
  warehouse_id: z.string().trim().min(1).max(64),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    // Atomic upsert-increment: row-level lock on conflict serializes concurrent bumps,
    // so two devices on the same warehouse never see the same serial.
    const r = await pool.query<{ current_serial: string }>(
      `INSERT INTO rfid_serial_counters (warehouse_id, current_serial)
       VALUES ($1::text, 1)
       ON CONFLICT (warehouse_id) DO UPDATE
         SET current_serial = rfid_serial_counters.current_serial + 1,
             updated_at = now()
       RETURNING current_serial::text`,
      [parsed.data.warehouse_id],
    );

    const next = Number(r.rows[0]?.current_serial ?? 0);
    return NextResponse.json(
      { serial: next },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[v1/rfid/serial/next]", e);
    return NextResponse.json({ error: "Serial allocation failed" }, { status: 500 });
  }
}
