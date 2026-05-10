import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { computeLightspeedSyncDiff } from "@/lib/server/lightspeed-sync-diff";
import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/inventory/sync/preview/[token]/xlsx
 *
 * Streams a three-sheet Excel file built from the cached preview:
 *   1. Full Catalog — every variant Lightspeed returned in this pull
 *   2. Items Gained — variants in LS but not in WMS (will be inserted)
 *   3. Items Lost   — variants in WMS but no longer in LS (will be archived)
 *
 * The diff lists are recomputed from the cached payload so the file matches
 * exactly what the modal showed. No write side effects.
 */

const HEADERS = [
  { header: "system_id", key: "ls_system_id", width: 14 },
  { header: "sku", key: "sku", width: 18 },
  { header: "name", key: "name", width: 36 },
  { header: "color", key: "color", width: 14 },
  { header: "size", key: "size", width: 10 },
  { header: "upc", key: "upc", width: 16 },
  { header: "vendor", key: "vendor", width: 16 },
  { header: "retail_price", key: "retail_price", width: 12 },
  { header: "archived", key: "archived", width: 10 },
] as const;

function applyHeaderStyle(ws: ExcelJS.Worksheet) {
  ws.columns = HEADERS.map((h) => ({ header: h.header, key: h.key, width: h.width }));
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { token } = await ctx.params;
  if (!/^pv-[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ error: "Invalid preview token" }, { status: 400 });
  }

  const r = await pool.query<{ payload: { catalog: CatalogSyncMatrixPayload[] } | null }>(
    `SELECT payload FROM sync_jobs WHERE preview_token = $1 AND tenant_id = $2::uuid LIMIT 1`,
    [token, session.tid],
  );
  const row = r.rows[0];
  if (!row?.payload?.catalog) {
    return NextResponse.json({ error: "Preview not found" }, { status: 404 });
  }

  const catalog = row.payload.catalog;
  const diff = await computeLightspeedSyncDiff(pool, catalog);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Carbon WMS";
  wb.created = new Date();

  // Sheet 1: Full Catalog (every variant from the LS pull)
  const wsCatalog = wb.addWorksheet("Full Catalog");
  applyHeaderStyle(wsCatalog);
  for (const m of catalog) {
    for (const v of m.variants) {
      wsCatalog.addRow({
        ls_system_id: String(v.lsSystemId),
        sku: v.sku,
        name: m.description,
        color: v.color ?? "",
        size: v.size ?? "",
        upc: v.upc ?? m.upc ?? "",
        vendor: m.vendor ?? "",
        retail_price: v.retailPrice ?? "",
        archived: v.archived ? "yes" : "",
      });
    }
  }

  // Sheet 2: Items Gained
  const wsGained = wb.addWorksheet("Items Gained");
  applyHeaderStyle(wsGained);
  for (const r2 of diff.gained) {
    wsGained.addRow({
      ls_system_id: r2.ls_system_id,
      sku: r2.sku,
      name: r2.name ?? "",
      color: r2.color ?? "",
      size: r2.size ?? "",
      upc: r2.upc ?? "",
      vendor: r2.vendor ?? "",
      retail_price: r2.retail_price ?? "",
      archived: r2.archived ? "yes" : "",
    });
  }

  // Sheet 3: Items Lost
  const wsLost = wb.addWorksheet("Items Lost");
  applyHeaderStyle(wsLost);
  for (const r2 of diff.lost) {
    wsLost.addRow({
      ls_system_id: r2.ls_system_id,
      sku: r2.sku,
      name: r2.name ?? "",
      color: r2.color ?? "",
      size: r2.size ?? "",
      upc: r2.upc ?? "",
      vendor: r2.vendor ?? "",
      retail_price: r2.retail_price ?? "",
      archived: r2.archived ? "yes" : "",
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="lightspeed-sync-preview-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
