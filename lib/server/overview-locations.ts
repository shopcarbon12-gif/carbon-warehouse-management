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
 * Soft-archive a bin. Call inside a DB transaction with `DELETE` route:
 * counts `items` with this `bin_id` and `status = 'in-stock'` before updating `archived_at`.
 */
export async function archiveBin(
  client: PoolClient,
  tenantId: string,
  binId: string,
): Promise<void> {
  const stock = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM items i
     INNER JOIN bins b ON b.id = i.bin_id
     INNER JOIN locations l ON l.id = b.location_id
     WHERE i.bin_id = $1::uuid
       AND l.tenant_id = $2::uuid
       AND i.status = 'in-stock'`,
    [binId, tenantId],
  );
  const n = Number(stock.rows[0]?.c ?? 0);
  if (n > 0) {
    throw new Error("BAD_REQUEST:Bin has in-stock EPCs — move inventory before archiving");
  }

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
}
