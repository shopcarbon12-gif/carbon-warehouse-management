import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

const handheldClientInfoSchema = z
  .object({
    appVersion: z.string().max(64).optional(),
    manufacturer: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    brand: z.string().max(128).optional(),
    product: z.string().max(128).optional(),
    device: z.string().max(128).optional(),
    hardware: z.string().max(128).optional(),
    androidRelease: z.string().max(32).optional(),
    sdkInt: z.number().int().min(1).max(999).optional(),
    serialNumber: z.string().max(256).optional(),
    wifiMac: z.string().max(32).optional(),
    bluetoothMac: z.string().max(32).optional(),
    radioVersion: z.string().max(256).optional(),
    fingerprint: z.string().max(512).optional(),
    incremental: z.string().max(128).optional(),
    display: z.string().max(128).optional(),
  })
  .strict();

const bodySchema = z.object({
  androidId: z.string().min(3).max(128).trim(),
  label: z.string().max(256).optional(),
  clientInfo: handheldClientInfoSchema.optional(),
});

function extractUsableMac(
  info: z.infer<typeof handheldClientInfoSchema> | undefined,
): string | null {
  const raw = info?.wifiMac?.trim() ?? "";
  if (!raw || !MAC_RE.test(raw)) return null;
  if (raw.toUpperCase() === "02:00:00:00:00:00") return null;
  return raw.toUpperCase();
}

function networkAddressForRow(androidId: string, info: z.infer<typeof handheldClientInfoSchema> | undefined) {
  return extractUsableMac(info) ?? androidId;
}

function configMergePayload(info: z.infer<typeof handheldClientInfoSchema> | undefined) {
  if (!info || Object.keys(info).length === 0) return null;
  return {
    handheld_client_info: info,
    handheld_client_info_at: new Date().toISOString(),
  };
}

/**
 * Registers this handheld's ANDROID_ID against the active location (pending authorization).
 * Optional [clientInfo] (serial, Wi‑Fi MAC, radio, build fingerprint, …) is merged into [devices.config]
 * for admin matching; [network_address] prefers a real Wi‑Fi MAC when the app reports one.
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

  const { androidId, label, clientInfo } = parsed.data;
  const name = (label?.trim() || `Handheld ${androidId.slice(0, 8)}`).slice(0, 256);
  const netAddr = networkAddressForRow(androidId, clientInfo);
  const configPatch = configMergePayload(clientInfo);
  const configJson = configPatch ? JSON.stringify(configPatch) : null;

  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id::text FROM devices WHERE android_id = $1 LIMIT 1`,
      [androidId],
    );
    if (existing.rows[0]) {
      const usableMac = extractUsableMac(clientInfo);
      await pool.query(
        `UPDATE devices d
         SET name = $2,
             location_id = $3::uuid,
             updated_at = now(),
             network_address = COALESCE(NULLIF($5, ''), d.network_address),
             config = CASE
               WHEN $6::text IS NULL THEN d.config
               ELSE COALESCE(d.config, '{}'::jsonb) || $6::jsonb
             END
         FROM locations l
         WHERE d.id = $1::uuid AND d.location_id = l.id AND l.tenant_id = $4::uuid`,
        [existing.rows[0].id, name, session.lid, session.tid, usableMac ?? "", configJson],
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
         COALESCE($5::jsonb, '{}'::jsonb), false, $6, false
       )
       RETURNING id::text`,
      [session.tid, session.lid, name, netAddr, configJson, androidId],
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
