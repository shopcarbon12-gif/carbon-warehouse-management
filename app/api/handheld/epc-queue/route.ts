import { NextResponse } from "next/server";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getPool } from "@/lib/db";
import { consumePendingEpcsForDevice } from "@/lib/queries/device-epc-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mobile-facing poll endpoint for the Cloud + Geiger screen.
 * Auth: edge api key + a deviceId hint (header `x-wms-device-id` OR query
 * `?deviceId=<name|android_id|uuid>`). Resolves to the device UUID via the
 * existing `devices` lookup, then drains and returns pending EPCs.
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const apiKey = extractEdgeApiKey(req);
  if (!verifyEdgeApiKey(apiKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const headerHint = req.headers.get("x-wms-device-id")?.trim() || null;
  const queryHint = url.searchParams.get("deviceId")?.trim() || null;
  const hint = headerHint || queryHint;
  if (!hint) {
    return NextResponse.json(
      { error: "deviceId required (x-wms-device-id header or ?deviceId= query)" },
      { status: 400 },
    );
  }

  /* Resolve the device row (matches name / config alias / android_id / uuid). */
  const dev = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT d.id::text, d.tenant_id::text
     FROM devices d
     WHERE (
       lower(trim(d.name)) = lower(trim($1::text))
       OR lower(trim(d.config->>'deviceId')) = lower(trim($1::text))
       OR lower(trim(d.config->>'edgeDeviceId')) = lower(trim($1::text))
       OR lower(trim(coalesce(d.android_id, ''))) = lower(trim($1::text))
       OR d.id::text = trim($1::text)
     )
       AND d.device_type = 'handheld_reader'
       AND COALESCE(d.is_authorized, FALSE) = TRUE
     LIMIT 1`,
    [hint],
  );
  const row = dev.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Device not registered or not authorized" }, { status: 403 });
  }

  try {
    const rows = await consumePendingEpcsForDevice(pool, row.id);
    return NextResponse.json(
      { deviceUuid: row.id, epcs: rows.map((r) => r.epc), count: rows.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[handheld/epc-queue]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
