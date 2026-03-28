import type { Sql } from "@/lib/db";

export type InventoryRow = {
  id: string;
  asset_id: string;
  sku: string;
  name: string;
  zone: string;
  qty: number;
};

export async function listInventory(
  sql: Sql,
  locationId: string,
  opts: { q?: string; zone?: string; limit: number; offset: number },
): Promise<InventoryRow[]> {
  const q = opts.q?.trim().toLowerCase();
  const zone = opts.zone?.trim();

  if (q && zone) {
    return sql<InventoryRow[]>`
      SELECT id, asset_id, sku, name, zone, qty
      FROM inventory_items
      WHERE location_id = ${locationId}::uuid
        AND zone = ${zone}
        AND (
          lower(asset_id) LIKE ${"%" + q + "%"}
          OR lower(sku) LIKE ${"%" + q + "%"}
          OR lower(name) LIKE ${"%" + q + "%"}
        )
      ORDER BY sku ASC
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `;
  }
  if (q) {
    return sql<InventoryRow[]>`
      SELECT id, asset_id, sku, name, zone, qty
      FROM inventory_items
      WHERE location_id = ${locationId}::uuid
        AND (
          lower(asset_id) LIKE ${"%" + q + "%"}
          OR lower(sku) LIKE ${"%" + q + "%"}
          OR lower(name) LIKE ${"%" + q + "%"}
        )
      ORDER BY sku ASC
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `;
  }
  if (zone) {
    return sql<InventoryRow[]>`
      SELECT id, asset_id, sku, name, zone, qty
      FROM inventory_items
      WHERE location_id = ${locationId}::uuid AND zone = ${zone}
      ORDER BY sku ASC
      LIMIT ${opts.limit} OFFSET ${opts.offset}
    `;
  }
  return sql<InventoryRow[]>`
    SELECT id, asset_id, sku, name, zone, qty
    FROM inventory_items
    WHERE location_id = ${locationId}::uuid
    ORDER BY sku ASC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
}
