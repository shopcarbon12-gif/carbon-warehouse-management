import type { Pool } from "pg";

export type InventoryRow = {
  id: string;
  asset_id: string;
  sku: string;
  name: string;
  zone: string;
  qty: number;
};

export async function listInventory(
  pool: Pool,
  locationId: string,
  opts: { q?: string; zone?: string; limit: number; offset: number },
): Promise<InventoryRow[]> {
  const q = opts.q?.trim().toLowerCase();
  const zone = opts.zone?.trim();
  const params: unknown[] = [locationId];
  let p = 2;
  const where: string[] = [`location_id = $1::uuid`];

  if (zone) {
    where.push(`zone = $${p}`);
    params.push(zone);
    p += 1;
  }
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(lower(asset_id) LIKE $${p} OR lower(sku) LIKE $${p + 1} OR lower(name) LIKE $${p + 2})`,
    );
    params.push(like, like, like);
    p += 3;
  }

  params.push(opts.limit, opts.offset);
  const sql = `
    SELECT id, asset_id, sku, name, zone, qty
    FROM inventory_items
    WHERE ${where.join(" AND ")}
    ORDER BY sku ASC
    LIMIT $${p} OFFSET $${p + 1}
  `;
  const r = await pool.query<InventoryRow>(sql, params);
  return r.rows;
}
