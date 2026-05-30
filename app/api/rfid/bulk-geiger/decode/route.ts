import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk Geiger second-pass resolver for "not found" EPCs.
 *
 * Some RFID tags encode their custom SKU directly in the first 13 characters of
 * the EPC — the "C-prefix" formula:
 *   C11121246040518149709975  ->  C111212460405   (= custom_skus.sku)
 *
 * For EPCs the normal items lookup couldn't resolve (no items row yet — the tag
 * isn't commissioned), decode that SKU from the EPC string and pull the catalog
 * row so the geiger report shows the item's description/color/size anyway.
 * custom_skus + matrices are single-tenant, so we match by SKU alone.
 */
const CPREFIX_SKU_LEN = 13;
const MAX_EPCS = 5000;

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let epcs: string[] = [];
  try {
    const body = (await req.json()) as { epcs?: unknown };
    if (Array.isArray(body.epcs)) {
      epcs = body.epcs
        .slice(0, MAX_EPCS)
        .map((e) => String(e ?? "").trim().toUpperCase())
        .filter(Boolean);
    }
  } catch {
    return NextResponse.json({ error: "Expected { epcs: string[] }" }, { status: 400 });
  }
  if (epcs.length === 0) return NextResponse.json({ rows: [] });

  // Decoded SKU code -> the EPC(s) that decoded to it.
  const codeToEpcs = new Map<string, string[]>();
  for (const epc of epcs) {
    if (!epc.startsWith("C") || epc.length < CPREFIX_SKU_LEN) continue;
    const code = epc.slice(0, CPREFIX_SKU_LEN);
    const arr = codeToEpcs.get(code) ?? [];
    arr.push(epc);
    codeToEpcs.set(code, arr);
  }
  if (codeToEpcs.size === 0) return NextResponse.json({ rows: [] });

  const cat = await pool.query<{
    sku_key: string;
    sku: string;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    vendor: string | null;
    retail_price: string | null;
    custom_sku_id: string;
    system_id: string | null;
  }>(
    `SELECT UPPER(cs.sku) AS sku_key,
            cs.sku,
            m.description AS name,
            cs.color_code AS color,
            cs.size,
            COALESCE(cs.upc, m.upc) AS upc,
            m.vendor,
            cs.retail_price::text AS retail_price,
            cs.id::text AS custom_sku_id,
            cs.ls_system_id::text AS system_id
       FROM custom_skus cs
       LEFT JOIN matrices m ON m.id = cs.matrix_id
      WHERE UPPER(cs.sku) = ANY($1::text[])`,
    [[...codeToEpcs.keys()]],
  );

  const rows: Array<Record<string, unknown>> = [];
  for (const cr of cat.rows) {
    for (const epc of codeToEpcs.get(cr.sku_key) ?? []) {
      rows.push({
        epc,
        sku: cr.sku,
        name: cr.name,
        color: cr.color,
        size: cr.size,
        upc: cr.upc,
        vendor: cr.vendor,
        retail_price: cr.retail_price,
        custom_sku_id: cr.custom_sku_id,
        system_id: cr.system_id,
      });
    }
  }
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
