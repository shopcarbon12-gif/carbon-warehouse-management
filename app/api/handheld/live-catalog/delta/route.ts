import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  buildLiveCatalogDelta,
  liveCatalogJsonResponse,
  resolveLiveCatalogLocationId,
} from "@/lib/server/live-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/handheld/live-catalog/delta?deviceId=<id>&since=<cursor>
 *
 * What changed in the tenant's live catalog since `since` (the cursor of the
 * previous snapshot/delta). Pulled every ~3 s while a handheld scans; an idle
 * reply is a few hundred bytes. A missing / expired / unusable cursor answers
 * 200 with `reset: true` (never a 4xx) so the phone re-downloads the snapshot.
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
    const payload = await buildLiveCatalogDelta(pool, {
      tenantId: auth.tenantId,
      locationId,
      since: searchParams.get("since"),
    });
    return await liveCatalogJsonResponse(req, payload);
  } catch (e) {
    console.error("[handheld/live-catalog/delta GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
