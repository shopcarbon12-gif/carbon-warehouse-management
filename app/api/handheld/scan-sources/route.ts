import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { listScanSources } from "@/lib/queries/scan-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/handheld/scan-sources
 *
 * Source picker for Add-On Count. Returns the v1 source set:
 * Mobile Count, Cycle Count, CSV Import (Live Scan + Antenna Test
 * dropped from v1 per Q3/Q5 locks).
 *
 * Query params:
 *   ?deviceId=<id>            (edge-key auth path)
 *   ?includeCompleted=1       (default: hide completed rows)
 *   ?limit=<int 1-500>        (default: 100)
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get("deviceId") ?? undefined;
  const auth = await resolveTenantOrError(req, pool, deviceId);
  if (auth instanceof Response) return auth;

  const includeCompleted = searchParams.get("includeCompleted") === "1";
  const limit = Math.min(
    500,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "100", 10) || 100),
  );

  try {
    const rows = await listScanSources(pool, auth.tenantId, { includeCompleted, limit });
    return NextResponse.json(
      { rows, count: rows.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[handheld/scan-sources GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
