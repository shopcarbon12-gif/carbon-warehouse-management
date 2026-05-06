import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  getScanSourceEpcs,
  type ScanSourceType,
} from "@/lib/queries/scan-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/handheld/scan-sources/<id>/epcs?type=<source_type>&deviceId=<id>
 *
 * Flat EPC array for a single source. Gzipped when the client supports it
 * (the handheld always does — keeps a 20K-EPC list under 100 KB on the wire).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const deviceId = searchParams.get("deviceId") ?? undefined;
  const sourceType = searchParams.get("type") as ScanSourceType | null;

  if (!sourceType || !["mobile_count", "cycle_count", "csv_import"].includes(sourceType)) {
    return NextResponse.json(
      { error: "type query param required: mobile_count | cycle_count | csv_import" },
      { status: 400 },
    );
  }

  const auth = await resolveTenantOrError(req, pool, deviceId);
  if (auth instanceof Response) return auth;

  try {
    const epcs = await getScanSourceEpcs(pool, auth.tenantId, sourceType, id);
    if (!epcs) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const body = JSON.stringify({ source_type: sourceType, source_id: id, epcs });

    const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
    if (acceptsGzip && body.length > 1024) {
      const gzipped = gzipSync(body);
      return new Response(gzipped, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[handheld/scan-sources/<id>/epcs GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
