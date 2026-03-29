import { NextResponse } from "next/server";
import { z } from "zod";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getPool } from "@/lib/db";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import { enqueueEdgeIngestJob } from "@/lib/server/edge-ingest-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  scanContext: z.string().min(1).max(64),
  timestamp: z.string().optional(),
  epcs: z.array(z.string()).max(8000),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * Handheld firehose: validate API key + registered device, enqueue work, **202** immediately.
 * Heavy work runs in `lib/server/edge-ingest-queue.ts` → `inventory-reconciler.ts`.
 */
export async function POST(req: Request) {
  const apiKey = extractEdgeApiKey(req);
  if (!verifyEdgeApiKey(apiKey)) {
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
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const device = await resolveEdgeDeviceCached(pool, parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not registered" }, { status: 403 });
  }

  const epcsDeduped = [
    ...new Set(
      parsed.data.epcs.map((e) => e.replace(/\s/g, "").toUpperCase()).filter(Boolean),
    ),
  ];

  enqueueEdgeIngestJob({
    tenantId: device.tenantId,
    locationId: device.locationId,
    deviceId: parsed.data.deviceId.trim(),
    scanContext: parsed.data.scanContext.trim(),
    epcs: epcsDeduped,
    metadata: parsed.data.metadata ?? {},
    timestamp: parsed.data.timestamp,
  });

  return NextResponse.json(
    { accepted: true, queued_epcs: epcsDeduped.length },
    { status: 202 },
  );
}
