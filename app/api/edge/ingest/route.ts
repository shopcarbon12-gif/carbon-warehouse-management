import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authorizeHandheldDeviceRequest } from "@/lib/server/handheld-request-auth";
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
 * Handheld firehose: edge API key **or** mobile Bearer session + registered device, **202** immediately.
 * Heavy work runs in `lib/server/edge-ingest-queue.ts` → `inventory-reconciler.ts`.
 */
export async function POST(req: Request) {
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

  const auth = await authorizeHandheldDeviceRequest(pool, req, parsed.data.deviceId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const device = auth.device;

  const epcsDeduped = [
    ...new Set(
      parsed.data.epcs.map((e) => e.replace(/\s/g, "").toUpperCase()).filter(Boolean),
    ),
  ];

  enqueueEdgeIngestJob({
    tenantId: device.tenantId,
    locationId: device.locationId,
    deviceId: parsed.data.deviceId.trim(), // android_id or UUID — reconciler stores as sent
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
