import type { Pool, PoolClient } from "pg";

export type ManualCatalogLineInput = {
  matrixUpc: string;
  matrixDescription: string;
  sku: string;
  vendor?: string | null;
  color?: string | null;
  size?: string | null;
  retailPrice?: string | null;
  variantUpc?: string | null;
};

/** Negative `ls_system_id` space reserved for manual / CSV rows (Lightspeed uses positives). */
async function nextManualLsSystemId(client: PoolClient): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT (COALESCE(MIN(ls_system_id), 0) - 1)::text AS n
     FROM custom_skus
     WHERE ls_system_id < 0`,
  );
  const n = Number(r.rows[0]?.n);
  if (!Number.isFinite(n) || n >= 0) {
    return -1_000_000_000_000_000;
  }
  return n;
}

/**
 * Upsert matrix by UPC and insert a new custom SKU with a synthetic negative `ls_system_id`.
 */
export async function createManualCatalogLine(
  pool: Pool,
  input: ManualCatalogLineInput,
): Promise<{ matrix_id: string; custom_sku_id: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const m = await client.query<{ id: string }>(
      `INSERT INTO matrices (upc, description, brand, category, vendor, ls_system_id)
       VALUES ($1, $2, NULL, NULL, $3, NULL)
       ON CONFLICT (upc) DO UPDATE SET
         description = EXCLUDED.description,
         vendor = COALESCE(EXCLUDED.vendor, matrices.vendor)
       RETURNING id::text`,
      [input.matrixUpc.trim(), input.matrixDescription.trim(), input.vendor?.trim() || null],
    );
    const matrixId = m.rows[0]?.id;
    if (!matrixId) throw new Error("matrix_upsert_failed");

    const lsId = await nextManualLsSystemId(client);
    const price =
      input.retailPrice != null && String(input.retailPrice).trim() !== ""
        ? Number.parseFloat(String(input.retailPrice))
        : null;
    const priceParam = price != null && Number.isFinite(price) ? String(price) : null;

    const cs = await client.query<{ id: string }>(
      `INSERT INTO custom_skus (
         matrix_id, sku, ls_system_id, color_code, size, retail_price, upc
       )
       VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6::numeric, $7)
       RETURNING id::text`,
      [
        matrixId,
        input.sku.trim(),
        lsId,
        input.color?.trim() || null,
        input.size?.trim() || null,
        priceParam,
        input.variantUpc?.trim() || null,
      ],
    );
    const customSkuId = cs.rows[0]?.id;
    if (!customSkuId) throw new Error("custom_sku_insert_failed");

    await client.query("COMMIT");
    return { matrix_id: matrixId, custom_sku_id: customSkuId };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export type CsvImportRowResult = { line: number; ok: boolean; error?: string };

/** Expected headers (case-insensitive): matrix_upc, sku, name, optional vendor, color, size, retail_price */
export async function importCatalogCsvRows(
  pool: Pool,
  csvText: string,
): Promise<{ created: number; results: CsvImportRowResult[] }> {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { created: 0, results: [{ line: 1, ok: false, error: "Need header + at least one data row" }] };
  }

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const idx = (name: string, ...alts: string[]) => {
    const names = [name, ...alts];
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iUpc = idx("matrix_upc", "upc", "matrixupc");
  const iSku = idx("sku", "custom_sku");
  const iName = idx("name", "description", "title");
  if (iUpc < 0 || iSku < 0 || iName < 0) {
    return {
      created: 0,
      results: [
        {
          line: 1,
          ok: false,
          error: "CSV must include columns: matrix_upc (or upc), sku, name (or description)",
        },
      ],
    };
  }

  const iVendor = idx("vendor");
  const iColor = idx("color", "color_code");
  const iSize = idx("size");
  const iPrice = idx("retail_price", "price");

  const split = (line: string) =>
    line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

  const results: CsvImportRowResult[] = [];
  let created = 0;

  for (let li = 1; li < lines.length; li++) {
    const lineNum = li + 1;
    const cells = split(lines[li]!);
    const matrixUpc = cells[iUpc]?.trim() ?? "";
    const sku = cells[iSku]?.trim() ?? "";
    const name = cells[iName]?.trim() ?? "";
    if (!matrixUpc || !sku || !name) {
      results.push({ line: lineNum, ok: false, error: "missing matrix_upc, sku, or name" });
      continue;
    }
    const vendor = iVendor >= 0 ? cells[iVendor]?.trim() || null : null;
    const color = iColor >= 0 ? cells[iColor]?.trim() || null : null;
    const size = iSize >= 0 ? cells[iSize]?.trim() || null : null;
    const retailPrice = iPrice >= 0 ? cells[iPrice]?.trim() || null : null;

    try {
      await createManualCatalogLine(pool, {
        matrixUpc,
        matrixDescription: name,
        sku,
        vendor,
        color,
        size,
        retailPrice,
        variantUpc: null,
      });
      created += 1;
      results.push({ line: lineNum, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ line: lineNum, ok: false, error: msg.slice(0, 200) });
    }
  }

  return { created, results };
}
