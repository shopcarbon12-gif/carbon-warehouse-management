import type { Pool } from "pg";

export type CommissionSkuMatch = {
  id: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
  /** Hang-tag label fields (OLA template): size = @item_attr4, color = @item_attr3, price = @retail_price. */
  size: string | null;
  color: string | null;
  price: string | null;
  /**
   * Where this variant actually lives: the bin holding the most in-stock EPCs
   * of the SKU, falling back to the variant's assigned "home bin"
   * (custom_skus.assigned_bin_id, migration 056) when it has no live stock.
   *
   * Home bin alone is not usable here — only 3 of 7,677 variants have one set,
   * so the column would be blank for effectively every search result. The
   * catalog grid uses the same precedence.
   */
  bin_code: string | null;
};

/** Broad lookup: System ID (exact when query is all-digits), SKU, UPC/EAN, description (substring). */
export async function searchSkusForCommission(
  pool: Pool,
  query: string,
  limit: number,
): Promise<CommissionSkuMatch[]> {
  const q = query.trim();
  if (!q) return [];

  const digitsOnly = /^\d+$/.test(q);
  const qDigits = q.replace(/\D/g, "");

  const r = await pool.query<{
    id: string;
    sku: string;
    ls_system_id: string;
    upc: string;
    description: string;
    size: string | null;
    color: string | null;
    price: string | null;
    bin_code: string | null;
  }>(
    `SELECT
       cs.id,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       coalesce(nullif(cs.upc, ''), m.upc) AS upc,
       m.description,
       cs.size,
       cs.color_code AS color,
       cs.retail_price::text AS price,
       COALESCE(live_bin.code, home_bin.code) AS bin_code
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins home_bin ON home_bin.id = cs.assigned_bin_id
     LEFT JOIN LATERAL (
       SELECT b2.code
         FROM items i
         INNER JOIN bins b2 ON b2.id = i.bin_id
        WHERE i.custom_sku_id = cs.id
          AND i.status = 'in-stock'
        GROUP BY b2.code
        ORDER BY count(*) DESC, b2.code ASC
        LIMIT 1
     ) live_bin ON true
     WHERE
       strpos(lower(cs.sku), lower($1::text)) > 0
       OR strpos(lower(m.upc), lower($1::text)) > 0
       OR strpos(lower(coalesce(m.description, '')), lower($1::text)) > 0
       OR ($2::boolean AND cs.ls_system_id::text = $1::text)
       OR (
         length($3::text) >= 4
         AND regexp_replace(m.upc, '[^0-9]', '', 'g') LIKE '%' || $3::text || '%'
       )
     ORDER BY cs.sku ASC
     LIMIT $4`,
    [q, digitsOnly, qDigits || "0000", limit],
  );

  return r.rows;
}

export type PrintLogRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

export async function listRfidPrintAudit(
  pool: Pool,
  tenantId: string,
  options: { limit: number; q?: string },
): Promise<PrintLogRow[]> {
  const { limit, q } = options;
  const filter = q?.trim();

  if (filter) {
    const r = await pool.query<{
      id: string;
      action: string;
      entity: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT id, action, entity, metadata, created_at
       FROM audit_log
       WHERE tenant_id = $1::uuid
         AND action = 'rfid_print'
         AND (
           strpos(lower(entity), lower($2::text)) > 0
           OR strpos(lower(metadata::text), lower($2::text)) > 0
         )
       ORDER BY created_at DESC
       LIMIT $3`,
      [tenantId, filter, limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      action: row.action,
      entity: row.entity,
      metadata: row.metadata,
      created_at: row.created_at.toISOString(),
    }));
  }

  const r = await pool.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT id, action, entity, metadata, created_at
     FROM audit_log
     WHERE tenant_id = $1::uuid
       AND action = 'rfid_print'
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
  }));
}
