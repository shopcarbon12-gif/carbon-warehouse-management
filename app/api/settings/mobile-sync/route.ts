import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ensureTenantSettings } from "@/lib/queries/tenant-settings";
import { authorizeHandheldDeviceRequest } from "@/lib/server/handheld-request-auth";
import type { EpcProfile } from "@/lib/settings/tenant-settings-defaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Handheld config sync: edge API key **or** mobile Bearer session + `deviceId`
 * (android_id, devices.id UUID, name, or config aliases).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId")?.trim() ?? "";
  if (!deviceId) {
    return NextResponse.json({ error: "deviceId query parameter required" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const auth = await authorizeHandheldDeviceRequest(pool, req, deviceId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const row = await ensureTenantSettings(pool, auth.device.tenantId);
    const activeProfiles: EpcProfile[] = row.epc_profiles.filter((p) => p.isActive);

    // Source of truth for EPC bit-decode (used by handheld Count/Encode screens
    // so they decode systemId with the same formula `lib/server/epc-decode.ts`
    // applies on every server-side ingress / lookup-by-epc).
    const cfgRow = await pool.query<{
      prefix_hex: string;
      prefix_bits: number;
      asset_bits: number;
      serial_bits: number;
      asset_padding_digits: number;
    }>(
      `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
         FROM tenant_epc_config WHERE tenant_id = $1::uuid LIMIT 1`,
      [auth.device.tenantId],
    );
    const epcConfig = cfgRow.rows[0]
      ? {
          prefix_hex: cfgRow.rows[0].prefix_hex,
          prefix_bits: cfgRow.rows[0].prefix_bits,
          asset_bits: cfgRow.rows[0].asset_bits,
          serial_bits: cfgRow.rows[0].serial_bits,
          asset_padding_digits: cfgRow.rows[0].asset_padding_digits,
        }
      : null;

    return NextResponse.json(
      {
        handheld_settings: row.handheld_settings,
        epc_settings: row.epc_settings,
        epc_profiles: activeProfiles,
        epc_config: epcConfig,
        updated_at: row.updated_at,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[mobile-sync GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
