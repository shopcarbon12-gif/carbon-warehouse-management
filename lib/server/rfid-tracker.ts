import type { Pool } from "pg";
import type {
  TrackerItemDetail,
  TrackerSearchPickRow,
  TrackerSearchResult,
} from "@/lib/rfid-tracker-types";

export type { TrackerItemDetail, TrackerSearchPickRow, TrackerSearchResult };

export type TrackerHistoryRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

export function isEpcHex24(q: string): boolean {
  const t = normalizeEpc(q);
  return /^[0-9A-F]{24}$/.test(t);
}

export async function getTrackerItemByEpc(
  pool: Pool,
  tenantId: string,
  epcRaw: string,
): Promise<TrackerItemDetail | null> {
  const epc = normalizeEpc(epcRaw);
  const r = await pool.query<{
    id: string;
    epc: string;
    serial_number: string;
    status: string;
    created_at: Date;
    custom_sku_id: string;
    sku: string;
    ls_system_id: string;
    upc: string;
    description: string;
    location_id: string;
    location_code: string;
    location_name: string;
    bin_id: string | null;
    bin_code: string | null;
  }>(
    `SELECT
       i.id::text,
       i.epc,
       i.serial_number::text,
       i.status,
       i.created_at,
       i.custom_sku_id::text,
       cs.sku,
       cs.ls_system_id::text,
       m.upc,
       m.description,
       i.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       i.bin_id::text AS bin_id,
       b.code AS bin_code
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.epc = $2
     LIMIT 1`,
    [tenantId, epc],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    epc: normalizeEpc(row.epc),
    serial_number: row.serial_number,
    status: row.status,
    created_at: row.created_at.toISOString(),
    custom_sku_id: row.custom_sku_id,
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    upc: row.upc,
    description: row.description,
    location_id: row.location_id,
    location_code: row.location_code,
    location_name: row.location_name,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
  };
}

export async function searchTrackerBySkuOrSystemId(
  pool: Pool,
  tenantId: string,
  q: string,
): Promise<TrackerSearchPickRow[]> {
  const raw = q.trim();
  if (!raw) return [];

  const digitsOnly = /^\d+$/.test(raw);

  const r = await pool.query<{
    epc: string;
    sku: string;
    ls_system_id: string;
    description: string;
    status: string;
    location_code: string;
    bin_code: string | null;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       m.description,
       i.status,
       l.code AS location_code,
       b.code AS bin_code
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE
       ($2::boolean AND cs.ls_system_id::text = $3::text)
       OR (
         NOT $2::boolean
         AND (
           strpos(lower(cs.sku), lower($3::text)) > 0
           OR lower(cs.sku) = lower($3::text)
         )
       )
     ORDER BY cs.sku ASC, i.epc ASC
     LIMIT 80`,
    [tenantId, digitsOnly, raw],
  );

  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    description: row.description,
    status: row.status,
    location_code: row.location_code,
    bin_code: row.bin_code,
  }));
}

export async function searchEpcTracker(
  pool: Pool,
  tenantId: string,
  q: string,
): Promise<TrackerSearchResult> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { mode: "pick", matches: [] };
  }

  if (isEpcHex24(trimmed)) {
    const item = await getTrackerItemByEpc(pool, tenantId, trimmed);
    if (item) return { mode: "direct", item };
    return { mode: "pick", matches: [] };
  }

  const matches = await searchTrackerBySkuOrSystemId(pool, tenantId, trimmed);
  return { mode: "pick", matches };
}

/**
 * Audit rows that reference this EPC in metadata (known shapes + text fallback).
 */
export async function listAuditHistoryForEpc(
  pool: Pool,
  tenantId: string,
  epcRaw: string,
  limit: number,
): Promise<TrackerHistoryRow[]> {
  const epc = normalizeEpc(epcRaw);
  if (!/^[0-9A-F]{24}$/.test(epc)) return [];

  const r = await pool.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT id::text, action, entity, metadata, created_at
     FROM audit_log
     WHERE tenant_id = $1::uuid
       AND (
         (metadata->>'epc') = $2
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(metadata->'inserted', '[]'::jsonb)) AS el
           WHERE (el->>'epc') = $2
         )
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(COALESCE(metadata->'epcs', '[]'::jsonb)) AS t
           WHERE upper(t) = $2
         )
         OR strpos(upper(metadata::text), $2) > 0
       )
     ORDER BY created_at DESC
     LIMIT $3`,
    [tenantId, epc, limit],
  );

  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
  }));
}
