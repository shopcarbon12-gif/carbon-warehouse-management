import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

const bodySchema = z.object({
  old_epc: z.string().trim().max(96).optional(),
  new_epc: z.string().trim().max(96).optional(),
  system_id: z.union([z.number(), z.string()]).optional(),
  serial: z.union([z.number(), z.string()]).optional(),
  custom_sku: z.string().trim().max(128).optional(),
  warehouse_id: z.string().trim().max(64).optional(),
  device_id: z.string().trim().max(128).optional(),
  encoded_at: z.string().trim().optional(),
  status: z.string().trim().max(32).optional(),
});

function toBigintString(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.trunc(v)) : null;
  if (typeof v === "string") return /^-?\d+$/.test(v.trim()) ? v.trim() : null;
  return null;
}

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

  const d = parsed.data;
  const encodedAt = d.encoded_at ? new Date(d.encoded_at) : null;
  if (encodedAt && Number.isNaN(encodedAt.getTime())) {
    return NextResponse.json({ error: "Invalid encoded_at" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO encode_events (
         old_epc, new_epc, system_id, serial, custom_sku,
         warehouse_id, device_id, status, encoded_at
       )
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, COALESCE($8, 'ok'), $9)
       RETURNING id`,
      [
        d.old_epc ?? null,
        d.new_epc ?? null,
        toBigintString(d.system_id),
        toBigintString(d.serial),
        d.custom_sku ?? null,
        d.warehouse_id ?? null,
        d.device_id ?? null,
        d.status ?? null,
        encodedAt,
      ],
    );

    return NextResponse.json({ id: r.rows[0].id }, { status: 201 });
  } catch (e) {
    console.error("[v1/rfid/encode-events]", e);
    return NextResponse.json({ error: "Insert failed" }, { status: 500 });
  }
}
