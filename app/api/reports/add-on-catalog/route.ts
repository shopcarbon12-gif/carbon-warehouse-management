import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  listAddOnCatalog,
  addOnCatalogCsv,
} from "@/lib/server/reports-add-on-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/reports/add-on-catalog (?q= ?format=csv) */
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
    const rows = await listAddOnCatalog(pool, session.tid, {
      search: q,
      limit: asCsv ? 5000 : 300,
    });
    if (asCsv) {
      return new NextResponse(addOnCatalogCsv(rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="add-on-catalog.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[reports/add-on-catalog]", e);
    return NextResponse.json({ error: "Report failed" }, { status: 500 });
  }
}
