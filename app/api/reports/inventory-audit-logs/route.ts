import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listInventoryAuditLogs } from "@/lib/queries/inventory-reports";
import { parseReportDateParam, validateReportDateRange } from "@/lib/report-date-params";

export const dynamic = "force-dynamic";

const ALLOWED_LOG_TYPES = new Set([
  "STATUS_CHANGE",
  "ADJUSTMENT",
  "KILLED_TAG",
  "RESOLVED_KILLED_TAG",
  "BULK_IMPORT",
]);

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const logTypeParam = searchParams.get("logType");
  const logTypes = logTypeParam
    ? logTypeParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALLOWED_LOG_TYPES.has(s))
    : undefined;
  const search = searchParams.get("search") ?? undefined;
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const dateFrom = parseReportDateParam(searchParams.get("dateFrom"));
  const dateTo = parseReportDateParam(searchParams.get("dateTo"));
  const range = validateReportDateRange(dateFrom, dateTo);
  if (!range.ok) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  try {
    const rows = await listInventoryAuditLogs(pool, session.tid, {
      logTypes: logTypes?.length ? logTypes : undefined,
      search,
      limit: Number.isFinite(limit) ? limit : undefined,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/inventory-audit-logs]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
