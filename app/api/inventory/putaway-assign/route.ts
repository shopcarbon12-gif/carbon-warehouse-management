import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { assignItemsToBinBySkuScan } from "@/lib/queries/putaway-assign";
import { authorizeHandheldDeviceRequest } from "@/lib/server/handheld-request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  binCode: z.string().min(1).max(64),
  skuScanned: z.string().min(1).max(256),
  scope: z.enum(["all_colors", "single_color"]),
});

export async function POST(req: Request) {
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

  const auth = await authorizeHandheldDeviceRequest(pool, req, parsed.data.deviceId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { updated } = await assignItemsToBinBySkuScan(
      pool,
      auth.device.locationId,
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
