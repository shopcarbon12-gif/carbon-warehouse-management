import { NextResponse } from "next/server";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getPool } from "@/lib/db";
import { ensureTenantSettings } from "@/lib/queries/tenant-settings";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import type { EpcProfile } from "@/lib/settings/tenant-settings-defaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Handheld config sync: same API key family as `/api/edge/ingest`, scoped by registered `deviceId`.
 */
export async function GET(req: Request) {
  const apiKey = extractEdgeApiKey(req);
  if (!verifyEdgeApiKey(apiKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId")?.trim() ?? "";
  if (!deviceId) {
    return NextResponse.json({ error: "deviceId query parameter required" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const device = await resolveEdgeDeviceCached(pool, deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not registered" }, { status: 403 });
  }

  try {
    const row = await ensureTenantSettings(pool, device.tenantId);
    const activeProfiles: EpcProfile[] = row.epc_profiles.filter((p) => p.isActive);
    return NextResponse.json(
      {
        handheld_settings: row.handheld_settings,
        epc_settings: row.epc_settings,
        epc_profiles: activeProfiles,
        updated_at: row.updated_at,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[mobile-sync GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
