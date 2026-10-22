import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { CATALOG_FILTERS, searchCatalog, type CatalogFilter } from "@/lib/server/grading-app";

export const dynamic = "force-dynamic";

/**
 * GET ?q=&filter=all|unmeasured|jeans|tshirts|shorts&limit= — the CarbonGradingAI
 * Catalog tab: CarbonWMS products matching a name, UPC, custom SKU, vendor or
 * colour, each with its sizes and which of them are measured.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const sp = new URL(req.url).searchParams;
  const f = sp.get("filter") ?? "all";
  const filter: CatalogFilter = (CATALOG_FILTERS as readonly string[]).includes(f) ? (f as CatalogFilter) : "all";
  const limit = Number(sp.get("limit") || 50);
  try {
    const rows = await searchCatalog(pool, sp.get("q") ?? "", filter, Number.isFinite(limit) ? limit : 50, session.lid ?? null);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not search" }, { status: 500 });
  }
}
