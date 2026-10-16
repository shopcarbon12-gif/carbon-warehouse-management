import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import {
  buildCycleCountReport,
  buildPhoneCountReport,
  CountReportNotFound,
} from "@/lib/server/count-report";
import { countReportResponse } from "@/lib/server/count-report-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/reports/count-report?kind=cycle_count|phone&id=<uuid>&format=json|xlsx|pdf
 *
 * The end-of-count report (owner, 2026-10-16): summary, every NEW Unknown tag
 * the count found with all its information, and the defective tags.
 *   kind=cycle_count — a desktop Cycle Count session (cycle_count_sessions.id)
 *   kind=phone       — a phone upload: Inventory Count, Add-On Count, Add-On
 *                      Catalog (inventory_reports.id)
 * Browser session or handheld token (resolveTenantOrError).
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  const id = searchParams.get("id") ?? "";
  if ((kind !== "cycle_count" && kind !== "phone") || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "kind (cycle_count | phone) and id required" }, { status: 400 });
  }
  const auth = await resolveTenantOrError(req, pool, searchParams.get("deviceId") ?? undefined);
  if (auth instanceof Response) return auth;
  try {
    const rep =
      kind === "cycle_count"
        ? await buildCycleCountReport(pool, auth.tenantId, id)
        : await buildPhoneCountReport(pool, auth.tenantId, id);
    return await countReportResponse(rep, searchParams.get("format"));
  } catch (e) {
    if (e instanceof CountReportNotFound) return NextResponse.json({ error: e.message }, { status: 404 });
    console.error("[reports/count-report]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
