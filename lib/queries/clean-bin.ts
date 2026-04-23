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

  const moved = skuPrefix
    ? await client.query<{ epc: string }>(
        `UPDATE items i
         SET bin_id = NULL
         FROM bins b
         INNER JOIN locations l ON l.id = b.location_id
         WHERE i.bin_id = b.id
           AND b.id = $1::uuid
           AND l.tenant_id = $2::uuid
           AND i.custom_sku_id IN (
             SELECT id FROM custom_skus WHERE sku LIKE $3
           )
         RETURNING i.epc`,
        [binId, tenantId, `${skuPrefix}%`],
      )
    : await client.query<{ epc: string }>(
        `UPDATE items i
         SET bin_id = NULL
         FROM bins b
         INNER JOIN locations l ON l.id = b.location_id
         WHERE i.bin_id = b.id
           AND b.id = $1::uuid
           AND l.tenant_id = $2::uuid
         RETURNING i.epc`,
        [binId, tenantId],
      );

  for (const row of moved.rows) {
    await client.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id
       )
       VALUES (
         $1::uuid, 'ADJUSTMENT', 'EPC', $2, $3, NULL, 'clean_bin', NULL
       )`,
      [tenantId, row.epc, binCode],
    );
  }

  return { cleared: moved.rows.length };
}
