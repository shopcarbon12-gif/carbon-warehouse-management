import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  androidId: z.string().min(3).max(128).trim(),
  label: z.string().max(256).optional(),
});

/**
 * Registers this handheld's ANDROID_ID against the active location (pending authorization).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { androidId, label } = parsed.data;
  const name = (label?.trim() || `Handheld ${androidId.slice(0, 8)}`).slice(0, 256);

  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id::text FROM devices WHERE android_id = $1 LIMIT 1`,
      [androidId],
    );
    if (existing.rows[0]) {
      await pool.query(
        `UPDATE devices d
         SET name = $2, location_id = $3::uuid, updated_at = now()
         FROM locations l
         WHERE d.id = $1::uuid AND d.location_id = l.id AND l.tenant_id = $4::uuid`,
        [existing.rows[0].id, name, session.lid, session.tid],
      );
      return NextResponse.json({ ok: true, deviceId: existing.rows[0].id, updated: true });
    }

    const ins = await pool.query<{ id: string }>(
      `INSERT INTO devices (
         tenant_id, location_id, bin_id, device_type, name, network_address,
         config, status_online, android_id, is_authorized
       )
       VALUES (
         $1::uuid, $2::uuid, NULL, 'handheld_reader', $3, $4,
         '{}'::jsonb, false, $4, false
       )
       RETURNING id::text`,
      [session.tid, session.lid, name, androidId],
    );
    const id = ins.rows[0]?.id;
    if (!id) throw new Error("insert failed");
    return NextResponse.json({ ok: true, deviceId: id, updated: false });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "Android ID already bound to another device" }, { status: 409 });
    }
    console.error("[mobile/device-ping]", e);
    return NextResponse.json({ error: "Register failed" }, { status: 500 });
  }
}
