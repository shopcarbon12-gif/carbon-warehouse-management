import { NextResponse } from "next/server";
import { z } from "zod";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getPool } from "@/lib/db";
import { assignItemsToBinBySkuScan } from "@/lib/queries/putaway-assign";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  binCode: z.string().min(1).max(64),
  skuScanned: z.string().min(1).max(256),
  scope: z.enum(["all_colors", "single_color"]),
});

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
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const device = await resolveEdgeDeviceCached(pool, parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not registered" }, { status: 403 });
  }

  try {
    const { updated } = await assignItemsToBinBySkuScan(
      pool,
      device.locationId,
      parsed.data.binCode,
      parsed.data.skuScanned,
      parsed.data.scope,
    );
    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    console.error("[putaway-assign]", e);
    return NextResponse.json({ error: "Putaway failed" }, { status: 500 });
  }
}
