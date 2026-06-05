import type { Pool } from "pg";
import { shortName } from "@/lib/format-name";

/**
 * Add-On Catalog report — tags promoted to LIVE (in-stock) by an operator.
 * Sourced from items that have a creating user (created_by_user_id) — i.e.
 * added on-device rather than imported — newest first, with the catalog SKU
 * and the actor as "First L.".
 */
export type AddOnCatalogRow = {
  epc: string;
  decoded_sku: string | null;
  decoded_system_id: string | null;
  added_status: string;
  added_at: string;
  added_by: string;
  location: string | null;
};

export async function listAddOnCatalog(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<AddOnCatalogRow[]> {
  const limit = Math.min(opts.limit ?? 300, 2000);
  const conds = [
    "l.tenant_id = $1::uuid",
    "i.created_by_user_id IS NOT NULL",
  ];
  const params: unknown[] = [tenantId];
  let p = 2;
  if (opts.search?.trim()) {
    conds.push(`(i.epc ILIKE $${p} OR cs.sku ILIKE $${p})`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }
  params.push(limit);
  const r = await pool.query<{
    epc: string;
    sku: string | null;
    ls_system_id: string | null;
    status: string;
    created_at: Date;
    location: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>(
    `SELECT i.epc,
            cs.sku,
            cs.ls_system_id::text AS ls_system_id,
            i.status,
            i.created_at,
            l.name AS location,
            u.first_name, u.last_name, u.email
       FROM items i
       INNER JOIN locations l ON l.id = i.location_id
       LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
       LEFT JOIN users u ON u.id = i.created_by_user_id
      WHERE ${conds.join(" AND ")}
      ORDER BY i.created_at DESC
      LIMIT $${p}`,
    params,
  );
  return r.rows.map((row) => ({
    epc: row.epc,
    decoded_sku: row.sku,
    decoded_system_id: row.ls_system_id,
    added_status: row.status === "in-stock" ? "LIVE" : row.status,
    added_at: row.created_at.toISOString(),
    added_by: shortName(row.first_name, row.last_name, row.email),
    location: row.location,
  }));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function addOnCatalogCsv(rows: AddOnCatalogRow[]): string {
  const header =
    "epc,decoded_sku,decoded_system_id,added_status,added_at,added_by,location";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        r.epc,
        r.decoded_sku,
        r.decoded_system_id,
        r.added_status,
        r.added_at,
        r.added_by,
        r.location,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
