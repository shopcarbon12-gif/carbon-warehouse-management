import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { listBinsWithCounts } from "@/lib/queries/locations";

export type LocationWithBinsRow = {
  id: string;
  code: string;
  name: string;
  bins: {
    id: string;
    code: string;
    capacity: number | null;
    in_stock_count: number;
    status: string;
    bin_items: string | null;
  }[];
};

export async function listTenantLocationsWithBins(
  pool: Pool,
  tenantId: string,
): Promise<LocationWithBinsRow[]> {
  const locs = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM locations
     WHERE tenant_id = $1::uuid
     ORDER BY code ASC`,
    [tenantId],
  );

  const out: LocationWithBinsRow[] = [];
  for (const l of locs.rows) {
    const bins = await listBinsWithCounts(pool, l.id);
    out.push({
      id: l.id,
      code: l.code,
      name: l.name,
      bins: bins.map((b) => ({
        id: b.id,
        code: b.code,
        capacity: b.capacity,
        in_stock_count: b.in_stock_count,
        status: b.status,
        bin_items: b.bin_items,
      })),
    });
  }
  return out;
}

export const upsertBinSchema = z.object({
  locationId: z.string().uuid(),
  binId: z.string().uuid().optional(),
  code: z.string().trim().min(1).max(64),
  capacity: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type UpsertBinBody = z.infer<typeof upsertBinSchema>;

export async function assertLocationTenant(
  client: Pool | PoolClient,
  locationId: string,
  tenantId: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [locationId, tenantId],
  );
  if (!r.rows[0]) throw new Error("BAD_REQUEST:Location not found");
}

export async function upsertBin(
  client: PoolClient,
  tenantId: string,
  body: UpsertBinBody,
): Promise<{ id: string }> {
  const parsed = upsertBinSchema.parse(body);
  await assertLocationTenant(client, parsed.locationId, tenantId);

  const status = parsed.status ?? "active";

  if (parsed.binId) {
    const u = await client.query<{ id: string }>(
      `UPDATE bins b
       SET code = $1, capacity = $2, status = $5
       FROM locations l
       WHERE b.id = $3::uuid
         AND b.location_id = l.id
         AND l.tenant_id = $4::uuid
         AND b.archived_at IS NULL
       RETURNING b.id::text`,
      [parsed.code, parsed.capacity ?? null, parsed.binId, tenantId, status],
    );
    if (!u.rows[0]) throw new Error("BAD_REQUEST:Bin not found or archived");
    return { id: u.rows[0].id };
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO bins (location_id, code, capacity, status)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text`,
    [parsed.locationId, parsed.code, parsed.capacity ?? null, status],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("SERVER:Insert failed");
  return { id };
}

/**
 * Delete a bin. NULLs out any items.bin_id pointing at it (so existing EPCs
 * stay in-stock at the location but lose their bin assignment), writes one
 * `clean_bin` audit row per moved EPC, then soft-archives the bin. The
 * bin code is suffixed with `·arch·<rand>` so the unique constraint on
 * (location_id, code) doesn't block re-creating a bin with the same name.
 *
 * The previous `archiveBin` behaviour blocked deletion when the bin had
 * any in-stock items. That left orphaned bins on the screen with no path
 * to remove them short of clean-bin. The new policy: delete is one-click;
 * items are auto-orphaned to bin_id NULL (operator can later re-assign).
 */
export async function deleteBin(
  client: PoolClient,
  tenantId: string,
  binId: string,
): Promise<{ orphaned: number }> {
  const bin = await client.query<{ code: string }>(
    `SELECT b.code
       FROM bins b
       INNER JOIN locations l ON l.id = b.location_id
      WHERE b.id = $1::uuid
        AND l.tenant_id = $2::uuid
        AND b.archived_at IS NULL
      LIMIT 1`,
    [binId, tenantId],
  );
  const binCode = bin.rows[0]?.code;
  if (!binCode) {
    throw new Error("BAD_REQUEST:Bin not found or already archived");
  }

  // 1. Orphan items: NULL out bin_id for everything pointing at this bin
  // (regardless of status — operator has decided to remove the bin).
  const orphaned = await client.query<{ epc: string }>(
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

  // 2. Audit each orphaned EPC with reason 'clean_bin' (mirrors the path
  // taken by the manual Clean flow — same downstream effect on the EPC).
  for (const row of orphaned.rows) {
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

  // 3. Soft-archive: keep the row + suffix the code so the unique
  // (location_id, code) constraint allows the operator to re-create a
  // bin with the same name afterwards.
  const u = await client.query(
    `UPDATE bins b
     SET archived_at = now(),
         code = b.code || '·arch·' || substr(md5(random()::text), 1, 6)
     FROM locations l
     WHERE b.id = $1::uuid
       AND b.location_id = l.id
       AND l.tenant_id = $2::uuid
       AND b.archived_at IS NULL`,
    [binId, tenantId],
  );
  if ((u.rowCount ?? 0) === 0) {
    throw new Error("BAD_REQUEST:Bin not found or already archived");
  }
  return { orphaned: orphaned.rowCount ?? 0 };
}

/** @deprecated retained for legacy callers — forwards to deleteBin which
 *  no longer blocks on in-stock items. */
export async function archiveBin(
  client: PoolClient,
  tenantId: string,
  binId: string,
): Promise<void> {
  await deleteBin(client, tenantId, binId);
}
