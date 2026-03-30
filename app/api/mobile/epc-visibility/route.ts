import { NextResponse } from "next/server";
import { z } from "zod";
import { extractEdgeApiKey, verifyEdgeApiKey } from "@/lib/auth/edge-auth";
import { getPool } from "@/lib/db";
import { resolveEdgeDeviceCached } from "@/lib/server/edge-device-cache";
import { resolveEpcVisibilityForTenant } from "@/lib/server/status-label-enforcement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  epcs: z.array(z.string()).max(2000),
});

/**
 * Handheld: resolve ghost-read filtering (hide_in_search_filters / hide_in_item_details / !auto_display).
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
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const device = await resolveEdgeDeviceCached(pool, parsed.data.deviceId.trim());
  if (!device) {
    return NextResponse.json({ error: "Device not registered" }, { status: 403 });
  }

  try {
    const results = await resolveEpcVisibilityForTenant(pool, device.tenantId, parsed.data.epcs);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[mobile/epc-visibility]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
