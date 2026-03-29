import type { Pool } from "pg";

export type CommissionSkuMatch = {
  id: string;
  sku: string;
  ls_system_id: string;
  upc: string;
  description: string;
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
  }>(
    `SELECT
       cs.id,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       m.upc,
       m.description
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
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
