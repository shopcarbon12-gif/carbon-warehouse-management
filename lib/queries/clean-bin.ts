import type { Pool, PoolClient } from "pg";

/**
 * Clears bin_id for items in the bin (tenant-scoped) and writes ADJUSTMENT audit rows.
 *
 * When `skuPrefix` is provided, only items whose `custom_skus.sku` starts with
 * that prefix are unassigned — used by the "remove one item group" flow on
 * /overview/locations. Prefix is 9 chars (non-legacy) or 11 chars (legacy `C*`).
 * When omitted, clears the whole bin (legacy behaviour).
 */
export async function cleanBinContents(
  client: PoolClient | Pool,
  tenantId: string,
  binId: string,
  skuPrefix?: string,
  userId?: string | null,
): Promise<{ cleared: number }> {
  const bin = await client.query<{ code: string }>(
    `SELECT b.code
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE b.id = $1::uuid AND l.tenant_id = $2::uuid AND b.archived_at IS NULL
     LIMIT 1`,
    [binId, tenantId],
  );
  const binCode = bin.rows[0]?.code;
  if (!binCode) throw new Error("NOT_FOUND");

  // A bin lists an item if THIS bin is its primary `bin_id` OR appears in
  // `additional_bin_ids` (multi-bin). Clearing only `bin_id` left multi-binned
  // items still showing in the bin — they "came back" after every Empty Bin
  // (operator hit this on 1A011R, had to swipe-delete each one). Clear BOTH.
  const prefixClause = skuPrefix
    ? `AND i.custom_sku_id IN (SELECT id FROM custom_skus WHERE sku LIKE $3)`
    : ``;
  const params: unknown[] = skuPrefix
    ? [binId, tenantId, `${skuPrefix}%`]
    : [binId, tenantId];

  // 1. Items whose PRIMARY home is this bin → homeless.
  const primary = await client.query<{ epc: string }>(
    `UPDATE items i
       SET bin_id = NULL
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE i.bin_id = b.id
       AND b.id = $1::uuid
       AND l.tenant_id = $2::uuid
       ${prefixClause}
     RETURNING i.epc`,
    params,
  );

  // 2. Items that merely LIST this bin as an additional (multi-bin) home.
  const secondary = await client.query<{ epc: string }>(
    `UPDATE items i
       SET additional_bin_ids = array_remove(i.additional_bin_ids, $1::uuid)
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE b.id = $1::uuid
       AND l.tenant_id = $2::uuid
       AND i.location_id = b.location_id
       AND $1::uuid = ANY(i.additional_bin_ids)
       ${prefixClause}
     RETURNING i.epc`,
    params,
  );

  const moved = { rows: [...primary.rows, ...secondary.rows] };

  for (const row of moved.rows) {
    await client.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid
       )
       VALUES (
         $1::uuid, 'ADJUSTMENT', 'EPC', $2, $3, NULL, 'clean_bin', NULL, $4::uuid
       )`,
      [tenantId, row.epc, binCode, userId ?? null],
    );
  }

  return { cleared: moved.rows.length };
}
