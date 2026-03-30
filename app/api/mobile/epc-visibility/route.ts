import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authorizeHandheldDeviceRequest } from "@/lib/server/handheld-request-auth";
import { resolveEpcVisibilityForTenant } from "@/lib/server/status-label-enforcement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  deviceId: z.string().min(1).max(256),
  epcs: z.array(z.string()).max(2000),
});

/**
 * Handheld: ghost-read filtering when `is_visible_to_scanner` is false (Clean 10 brain).
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
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const auth = await authorizeHandheldDeviceRequest(pool, req, parsed.data.deviceId.trim());
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const results = await resolveEpcVisibilityForTenant(pool, auth.device.tenantId, parsed.data.epcs);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[mobile/epc-visibility]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
