import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { generateNonRfidTag203 } from "@/lib/utils/zpl-carbon-tag-203";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Non-RFID price-tag ZPL for a SKU — the 2×3 in, 203 dpi Zebra .220 label.
 *
 * Pure read: NO serial minting, NO items insert (unlike /api/rfid/commission).
 * This is the companion price label printed AFTER an RFID tag is encoded —
 * used by the handheld Encode & Print screen, which sends the returned ZPL
 * straight to the Zebra .220 over raw TCP 9100 (lan_zpl_printer.dart). It is
 * the same artwork the web Tags & Labels "Non-RFID" tab prints via
 * generateNonRfidTag203Batch().
 *
 * GET /api/rfid/nonrfid-label?customSkuId=<uuid>
 *   → { zpl, sku, printer_host, printer_port, printer_uri }
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const customSkuId = new URL(req.url).searchParams.get("customSkuId")?.trim() ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(customSkuId)) {
    return NextResponse.json({ error: "Invalid customSkuId" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const row = await pool.query<{
      id: string;
      sku: string;
      upc: string | null;
      description: string | null;
      color_code: string | null;
      size: string | null;
      retail_price: string | null;
      matrix_id: string | null;
    }>(
      `SELECT cs.id::text,
              cs.sku,
              COALESCE(NULLIF(trim(cs.upc), ''), m.upc) AS upc,
              m.description,
              cs.color_code,
              cs.size,
              cs.retail_price::text AS retail_price,
              cs.matrix_id::text AS matrix_id
         FROM custom_skus cs
         LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.id = $1::uuid`,
      [customSkuId],
    );
    if (row.rowCount === 0 || !row.rows[0]) {
      return NextResponse.json({ error: "SKU not found" }, { status: 404 });
    }
    const r = row.rows[0];

    // Full size run in this matrix for the right-hand "sizes available" column.
    let sizesAvailable = "";
    if (r.matrix_id) {
      const sizesRow = await pool.query<{ size: string | null }>(
        `SELECT DISTINCT size FROM custom_skus
           WHERE matrix_id = $1::uuid AND archived = false AND size IS NOT NULL
           ORDER BY size`,
        [r.matrix_id],
      );
      sizesAvailable = sizesRow.rows
        .map((s) => (s.size ?? "").trim())
        .filter(Boolean)
        .join(", ");
    }

    const input: CarbonTagInput = {
      itemName: r.description ?? "",
      color: r.color_code ?? "",
      size: r.size ?? "",
      upc: r.upc ?? "",
      customSku: r.sku,
      retailPrice: r.retail_price ?? "0",
      sizesAvailable,
    };

    return NextResponse.json(
      {
        zpl: generateNonRfidTag203(input),
        sku: r.sku,
        // Zebra .220 (ZD500R, 203 dpi). Handheld prints over raw TCP 9100.
        printer_host: "192.168.1.220",
        printer_port: 9100,
        printer_uri: "PSTPRNT",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[rfid/nonrfid-label]", e);
    return NextResponse.json({ error: "Label generation failed" }, { status: 500 });
  }
}
