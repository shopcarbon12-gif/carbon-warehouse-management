import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  listStatusChanges,
  statusChangesCsv,
} from "@/lib/server/reports-status-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/status-changes
 *   ?damaged=true   → only DAMAGED transitions (Damages report)
 *   ?q=<epc>        → filter by EPC substring
 *   ?format=csv     → download CSV; otherwise JSON list
 *
 * Reads the STATUS_CHANGE rows already in inventory_audit_logs. Actor renders
 * as "First L.".
 */
export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const damagedOnly = searchParams.get("damaged") === "true";
  const q = searchParams.get("q")?.trim() ?? "";
  const asCsv = searchParams.get("format") === "csv";

  try {
    const rows = await listStatusChanges(pool, session.tid, {
      damagedOnly,
      search: q,
      limit: asCsv ? 5000 : 300,
    });

    if (asCsv) {
      const name = damagedOnly ? "damages" : "status-changes";
      return new NextResponse(statusChangesCsv(rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[reports/status-changes]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
