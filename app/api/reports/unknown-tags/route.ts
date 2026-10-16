import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { buildUnverifiedReport } from "@/lib/server/count-report";
import { countReportResponse } from "@/lib/server/count-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/unknown-tags?format=json|xlsx|pdf
 *
 * Every NEW Unknown tag still waiting for a person (owner, 2026-10-16): a
 * fresh number a count or reader found that was never recorded in the WMS
 * (items.fresh_found_at set, verified_at null). Changing its status — e.g. to
 * LIVE after finding it with Cloud + Geiger — takes it off this list.
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const auth = await resolveTenantOrError(req, pool, searchParams.get("deviceId") ?? undefined);
  if (auth instanceof Response) return auth;
  try {
    const rep = await buildUnverifiedReport(pool, auth.tenantId);
    return await countReportResponse(rep, searchParams.get("format"));
  } catch (e) {
    console.error("[reports/unknown-tags]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
