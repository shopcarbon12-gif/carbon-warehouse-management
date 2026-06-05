import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  listBinClearances,
  binClearanceCsv,
} from "@/lib/server/reports-bin-clearance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reports/bin-clearance  (?q=<bin>  ?format=csv)
 * Each clean-bin action: bin · count · time · First L.
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
  const q = searchParams.get("q")?.trim() ?? "";
  const asCsv = searchParams.get("format") === "csv";

  try {
    const rows = await listBinClearances(pool, session.tid, {
      search: q,
      limit: asCsv ? 5000 : 300,
    });
    if (asCsv) {
      return new NextResponse(binClearanceCsv(rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="bin-clearance.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[reports/bin-clearance]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
