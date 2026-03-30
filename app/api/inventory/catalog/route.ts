import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  listCatalogCustomSkus,
  listCatalogMatrices,
  listCatalogItemsForCustomSku,
} from "@/lib/queries/catalog";
import { listCatalogGrid } from "@/lib/server/inventory-catalog";

/**
 * GET ?view=grid&page=&limit=&q=&brand=&category=&vendor= — paginated matrix × custom SKU rows.
 * GET ?matrixId= — custom SKUs for one matrix (legacy expand).
 * GET ?customSkuId= — EPC rows for RFID modal.
 * GET (no params) — matrix aggregate list (legacy).
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const matrixId = searchParams.get("matrixId");
  const customSkuId = searchParams.get("customSkuId");
  const view = searchParams.get("view");

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  if (customSkuId) {
    if (!/^[0-9a-f-]{36}$/i.test(customSkuId)) {
      return NextResponse.json({ error: "Invalid customSkuId" }, { status: 400 });
    }
    const rows = await listCatalogItemsForCustomSku(pool, session.lid, customSkuId);
    return NextResponse.json(rows);
  }

  if (matrixId) {
    if (!/^[0-9a-f-]{36}$/i.test(matrixId)) {
      return NextResponse.json({ error: "Invalid matrixId" }, { status: 400 });
    }
    const rows = await listCatalogCustomSkus(pool, session.lid, matrixId);
    return NextResponse.json(rows);
  }

  if (view === "grid") {
    const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(searchParams.get("limit") ?? "50", 10) || 50),
    );
    const q = searchParams.get("q")?.trim() ?? "";
    const brand = searchParams.get("brand")?.trim() ?? "";
    const category = searchParams.get("category")?.trim() ?? "";
    const vendor = searchParams.get("vendor")?.trim() ?? "";

    try {
      const result = await listCatalogGrid(pool, {
        page,
        limit,
        q,
        brand,
        category,
        vendor,
        locationId: session.lid,
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      console.error("[inventory/catalog grid]", e);
      return NextResponse.json({ error: "Query failed" }, { status: 500 });
    }
  }

  const rows = await listCatalogMatrices(pool, session.lid);
  return NextResponse.json(rows);
}
