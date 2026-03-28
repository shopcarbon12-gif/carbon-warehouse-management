import type { Pool } from "pg";

export type InventoryRow = {
  sku: string;
  title: string | null;
  zone_code: string;
  quantity: number;
  shopify_variant_id: string | null;
  lightspeed_item_id: string | null;
};

export async function listInventory(pool: Pool): Promise<InventoryRow[]> {
  const { rows } = await pool.query<InventoryRow>(
    `SELECT s.sku, s.title, il.zone_code, il.quantity,
            s.shopify_variant_id, s.lightspeed_item_id
     FROM inventory_levels il
     JOIN skus s ON s.id = il.sku_id
     ORDER BY il.zone_code, s.sku`
  );
  return rows;
}

export async function inventoryTotalsByZone(
  pool: Pool
): Promise<{ zone_code: string; total: number }[]> {
  const { rows } = await pool.query<{ zone_code: string; total: string }>(
    `SELECT il.zone_code, SUM(il.quantity)::bigint AS total
     FROM inventory_levels il
     GROUP BY il.zone_code
     ORDER BY il.zone_code`
  );
  return rows.map((r) => ({
    zone_code: r.zone_code,
    total: Number(r.total),
  }));
}
