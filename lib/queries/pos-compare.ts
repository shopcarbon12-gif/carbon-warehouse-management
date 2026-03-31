import type { Pool } from "pg";

export type PosCompareSkuRow = {
  sku: string;
  name: string;
  /** R-Series `itemID` after a live catalog sync populates `custom_skus.ls_item_id`. */
  ls_item_id: string | null;
  expected_ls: number;
  wms_found: number;
  missing: number;
  extra: number;
};

export type PosCompareSummary = {
  total_expected: number;
  wms_total: number;
  missing_total: number;
  extra_total: number;
  rows: PosCompareSkuRow[];
};

export async function getPosCompareForLocation(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<PosCompareSummary> {
  const r = await pool.query<{
    sku: string;
    name: string;
    ls_item_id: string | null;
    expected_ls: string;
    wms_found: string;
  }>(
    `SELECT
       cs.sku,
       COALESCE(NULLIF(trim(m.description), ''), cs.sku) AS name,
       cs.ls_item_id::text AS ls_item_id,
       COALESCE(cs.ls_on_hand_total, 0)::text AS expected_ls,
       COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::text AS wms_found
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN items i
       ON i.custom_sku_id = cs.id
       AND i.location_id = $2::uuid
     WHERE EXISTS (
       SELECT 1 FROM locations l
       WHERE l.id = $2::uuid AND l.tenant_id = $1::uuid
     )
     GROUP BY cs.sku, m.description, cs.ls_on_hand_total, cs.ls_item_id
     ORDER BY cs.sku ASC`,
    [tenantId, locationId],
  );

  const rows: PosCompareSkuRow[] = r.rows.map((row) => {
    const expected = Number(row.expected_ls) || 0;
    const found = Number(row.wms_found) || 0;
    const missing = Math.max(0, expected - found);
    const extra = Math.max(0, found - expected);
    return {
      sku: row.sku,
      name: row.name,
      ls_item_id: row.ls_item_id && row.ls_item_id !== "" ? row.ls_item_id : null,
      expected_ls: expected,
      wms_found: found,
      missing,
      extra,
    };
  });

  const total_expected = rows.reduce((a, b) => a + b.expected_ls, 0);
  const wms_total = rows.reduce((a, b) => a + b.wms_found, 0);
  const missing_total = rows.reduce((a, b) => a + b.missing, 0);
  const extra_total = rows.reduce((a, b) => a + b.extra, 0);

  return {
    total_expected,
    wms_total,
    missing_total,
    extra_total,
    rows,
  };
}

export type SkuPushTargetRow = {
  sku: string;
  ls_item_id: string | null;
  wms_qoh: number;
};

/** Resolve SKUs to `ls_item_id` + in-stock WMS count for a tenant location (Lightspeed Item PUT). */
export async function getSkuPushTargetsForLocation(
  pool: Pool,
  tenantId: string,
  locationId: string,
  skus: string[],
): Promise<SkuPushTargetRow[]> {
  if (skus.length === 0) return [];
  const r = await pool.query<{
    sku: string;
    ls_item_id: string | null;
    wms_qoh: string;
  }>(
    `SELECT
       cs.sku,
       cs.ls_item_id::text AS ls_item_id,
       COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::text AS wms_qoh
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN items i
       ON i.custom_sku_id = cs.id
       AND i.location_id = $2::uuid
     WHERE cs.sku = ANY($3::text[])
       AND EXISTS (
         SELECT 1 FROM locations l
         WHERE l.id = $2::uuid AND l.tenant_id = $1::uuid
       )
     GROUP BY cs.sku, cs.ls_item_id, cs.id`,
    [tenantId, locationId, skus],
  );
  return r.rows.map((row) => ({
    sku: row.sku,
    ls_item_id: row.ls_item_id && row.ls_item_id !== "" ? row.ls_item_id : null,
    wms_qoh: Number(row.wms_qoh) || 0,
  }));
}
