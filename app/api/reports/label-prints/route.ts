import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  listLabelPrints,
  labelPrintsCsv,
} from "@/lib/server/reports-label-prints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/reports/label-prints?kind=rfid|non_rfid (?q= ?format=csv) */
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
  const kind = searchParams.get("kind") === "non_rfid" ? "non_rfid" : "rfid";
  const q = searchParams.get("q")?.trim() ?? "";
  const asCsv = searchParams.get("format") === "csv";
  try {
    const rows = await listLabelPrints(pool, session.tid, {
      kind,
      search: q,
      limit: asCsv ? 5000 : 300,
    });
    if (asCsv) {
      return new NextResponse(labelPrintsCsv(rows, kind), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="label-prints-${kind}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[reports/label-prints]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
