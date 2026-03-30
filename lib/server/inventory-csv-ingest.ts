import type { Pool } from "pg";

/** Minimal CSV parser: one row per line, comma-separated, trims cells, strips simple quotes. */
export function parseCsvLoose(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line: string) =>
    line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]!).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

function colIdx(headers: string[], ...names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Apply CSV rows to `items` for the given location: expects headers including
 * `epc` (or `tag`) and `bin` / `bin_code` / `destination_bin`.
 */
export async function applyInventoryCsvToItems(
  pool: Pool,
  tenantId: string,
  locationId: string,
  csvText: string,
): Promise<{ rowsProcessed: number; rowsUpdated: number; errors: string[] }> {
  const { headers, rows } = parseCsvLoose(csvText);
  const errors: string[] = [];
  if (headers.length === 0 || rows.length === 0) {
    return { rowsProcessed: 0, rowsUpdated: 0, errors: ["No data rows after header"] };
  }

  const iEpc = colIdx(headers, "epc", "tag", "epc_hex");
  const iBin = colIdx(headers, "bin", "bin_code", "destination_bin", "bincode");
  const iSku = colIdx(headers, "sku", "custom_sku");

  if (iEpc < 0 && iSku < 0) {
    return { rowsProcessed: 0, rowsUpdated: 0, errors: ["CSV must include epc or sku column"] };
  }
  if (iBin < 0) {
    return { rowsProcessed: 0, rowsUpdated: 0, errors: ["CSV must include bin column"] };
  }

  const locOk = await pool.query(
    `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [locationId, tenantId],
  );
  if (!locOk.rows[0]) {
    return { rowsProcessed: 0, rowsUpdated: 0, errors: ["Invalid location for tenant"] };
  }

  let rowsUpdated = 0;
  let rowsProcessed = 0;

  for (const row of rows) {
    rowsProcessed++;
    const binCode = row[iBin]?.trim();
    if (!binCode) {
      errors.push(`Row ${rowsProcessed}: missing bin`);
      continue;
    }

    const br = await pool.query<{ id: string }>(
      `SELECT id::text FROM bins WHERE location_id = $1::uuid AND code = $2 LIMIT 1`,
      [locationId, binCode],
    );
    const binId = br.rows[0]?.id;
    if (!binId) {
      errors.push(`Row ${rowsProcessed}: unknown bin ${binCode}`);
      continue;
    }

    if (iEpc >= 0) {
      const epc = row[iEpc]?.replace(/\s/g, "").toUpperCase();
      if (!epc) {
        errors.push(`Row ${rowsProcessed}: missing epc`);
        continue;
      }
      const ur = await pool.query(
        `UPDATE items i
         SET bin_id = $1::uuid
         FROM locations l
         WHERE i.epc = $2
           AND i.location_id = l.id
           AND l.tenant_id = $3::uuid
           AND i.location_id = $4::uuid`,
        [binId, epc, tenantId, locationId],
      );
      rowsUpdated += ur.rowCount ?? 0;
    } else if (iSku >= 0) {
      const sku = row[iSku]?.trim();
      if (!sku) {
        errors.push(`Row ${rowsProcessed}: missing sku`);
        continue;
      }
      const ur = await pool.query(
        `UPDATE items i
         SET bin_id = $1::uuid
         FROM custom_skus cs
         WHERE i.custom_sku_id = cs.id
           AND cs.sku = $2
           AND i.location_id = $3::uuid`,
        [binId, sku, locationId],
      );
      rowsUpdated += ur.rowCount ?? 0;
    }
  }

  return { rowsProcessed, rowsUpdated, errors };
}
