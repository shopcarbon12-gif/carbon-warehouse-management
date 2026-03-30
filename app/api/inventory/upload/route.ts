import { NextResponse } from "next/server";
import { z } from "zod";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { insertDeviceUploadLog } from "@/lib/queries/device-upload-logs";
import { applyInventoryCsvToItems } from "@/lib/server/inventory-csv-ingest";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256).optional(),
  mode: z.string().min(1).max(128),
  csvData: z.string().min(1).max(5_000_000),
});

export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
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

  const session = await getSession();
  let tenantId: string;
  let locationId: string;
  let deviceId: string;

  if (session) {
    tenantId = session.tid;
    locationId = session.lid;
    deviceId = parsed.data.deviceId?.trim() || "web-session";
  } else {
    const apiKey = extractEdgeApiKey(req);
    if (!verifyEdgeApiKey(apiKey)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const did = parsed.data.deviceId?.trim();
    if (!did) {
      return NextResponse.json({ error: "deviceId required for device uploads" }, { status: 400 });
    }
    const device = await resolveEdgeDeviceCached(pool, did);
    if (!device) {
      return NextResponse.json({ error: "Device not registered" }, { status: 403 });
    }
    tenantId = device.tenantId;
    locationId = device.locationId;
    deviceId = did;
  }

  try {
    const logId = await insertDeviceUploadLog(pool, tenantId, {
      device_id: deviceId,
      workflow_mode: parsed.data.mode,
      raw_csv: parsed.data.csvData,
    });

    const result = await applyInventoryCsvToItems(
      pool,
      tenantId,
      locationId,
      parsed.data.csvData,
    );

    return NextResponse.json({
      ok: true,
      logId,
      rowsProcessed: result.rowsProcessed,
      rowsUpdated: result.rowsUpdated,
      ingestErrors: result.errors.slice(0, 50),
    });
  } catch (e) {
    console.error("[inventory/upload]", e);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
