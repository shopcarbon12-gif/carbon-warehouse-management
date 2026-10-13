import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  buildLiveCatalogSnapshot,
  liveCatalogJsonResponse,
  resolveLiveCatalogLocationId,
} from "@/lib/server/live-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/handheld/live-catalog/snapshot?deviceId=<id>
 *
 * The tenant's full live catalog (every EPC's status + SKU / name / colour /
 * size / price / bins) for the handheld's local copy — Add-On Catalog and
 * Add-On Count decide each tag on the phone from it. Columnar JSON, gzipped.
 * Follow up with /delta?since=<cursor>. Payload: lib/server/live-catalog.ts.
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get("deviceId") ?? undefined;
  const auth = await resolveTenantOrError(req, pool, deviceId);
  if (auth instanceof Response) return auth;

  try {
    const locationId = await resolveLiveCatalogLocationId(pool, req, deviceId ?? null);
    const payload = await buildLiveCatalogSnapshot(pool, {
      tenantId: auth.tenantId,
      locationId,
    });
    return await liveCatalogJsonResponse(req, payload);
  } catch (e) {
    console.error("[handheld/live-catalog/snapshot GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
