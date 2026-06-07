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
    first_scanned_at: Date | null;
    source: string | null;
    source_device_label: string | null;
    source_device_id: string | null;
    source_device_name: string | null;
    source_antenna_id: string | null;
    source_antenna_name: string | null;
    created_by_user_id: string | null;
    created_by_email: string | null;
    created_by_first: string | null;
    created_by_last: string | null;
    custom_sku_id: string;
    sku: string;
    ls_system_id: string;
    shopify_image_url: string | null;
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
       i.first_scanned_at,
       i.source,
       i.source_device_label,
       i.source_device_id::text,
       sd.name AS source_device_name,
       i.source_antenna_id::text,
       sa.name AS source_antenna_name,
       i.created_by_user_id::text,
       cu.email AS created_by_email,
       cu.first_name AS created_by_first,
       cu.last_name AS created_by_last,
       i.custom_sku_id::text,
       cs.sku,
       cs.ls_system_id::text,
       cs.shopify_image_url,
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
     LEFT JOIN devices sd ON sd.id = i.source_device_id
     LEFT JOIN devices sa ON sa.id = i.source_antenna_id
     LEFT JOIN users   cu ON cu.id = i.created_by_user_id
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
    first_scanned_at: row.first_scanned_at ? row.first_scanned_at.toISOString() : null,
    source: row.source,
    source_device_label: row.source_device_label,
    source_device_id: row.source_device_id,
    source_device_name: row.source_device_name,
    source_antenna_id: row.source_antenna_id,
    source_antenna_name: row.source_antenna_name,
    created_by_user_id: row.created_by_user_id,
    created_by_email: row.created_by_email,
    created_by_first: row.created_by_first,
    created_by_last: row.created_by_last,
    custom_sku_id: row.custom_sku_id,
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    shopify_image_url: row.shopify_image_url ?? null,
    upc: row.upc,
    description: row.description,
    location_id: row.location_id,
    location_code: row.location_code,
    location_name: row.location_name,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
  };
}

/**
 * Broad-spectrum EPC search. Match on:
 *   - exact 24-hex EPC, or partial hex tail (≥4 chars, e.g. "1571")
 *   - exact ls_system_id (digits-only input)
 *   - SKU substring
 *   - matrix description (item name) substring
 *   - color, size, UPC, vendor, status, location code, bin code substring
 *
 * Always returns one row per EPC — no grouping. Operator gets a table they
 * can click to drill into status / decoded layout / audit timeline.
 *
 * Result limit bumped to 200 (was 80) so SKU searches with many tagged
 * units don't truncate. Archived custom_skus are included; the result
 * carries the flag so the UI can render an [ARCHIVED] badge.
 */
export async function searchEpcTrackerBroad(
  pool: Pool,
  tenantId: string,
  q: string,
): Promise<TrackerSearchPickRow[]> {
  const raw = q.trim();
  if (!raw) return [];

  const digitsOnly = /^\d+$/.test(raw);
  const epcHex24 = isEpcHex24(raw);
  const epcPartial = /^[0-9A-Fa-f]{4,23}$/.test(raw); // partial-hex tail
  const like = `%${raw.replace(/[\\%_]/g, (s) => `\\${s}`)}%`;
  const upperPartial = raw.toUpperCase();

  const r = await pool.query<{
    epc: string;
    sku: string;
    ls_system_id: string;
    description: string;
    color: string | null;
    size: string | null;
    upc: string | null;
    vendor: string | null;
    status: string;
    location_code: string;
    bin_code: string | null;
    archived: boolean;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       m.description,
       cs.color_code AS color,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       m.vendor,
       i.status,
       l.code AS location_code,
       b.code AS bin_code,
       cs.archived AS archived
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE
       ($2::boolean AND i.epc = $3::text)
       OR ($4::boolean AND strpos(i.epc, $5::text) > 0)
       OR ($6::boolean AND cs.ls_system_id::text = $7::text)
       OR cs.sku ILIKE $8 ESCAPE '\\'
       OR m.description ILIKE $8 ESCAPE '\\'
       OR COALESCE(cs.color_code, '') ILIKE $8 ESCAPE '\\'
       OR COALESCE(cs.size, '') ILIKE $8 ESCAPE '\\'
       OR COALESCE(cs.upc, '') ILIKE $8 ESCAPE '\\'
       OR COALESCE(m.upc, '') ILIKE $8 ESCAPE '\\'
       OR COALESCE(m.vendor, '') ILIKE $8 ESCAPE '\\'
       OR i.status ILIKE $8 ESCAPE '\\'
       OR l.code ILIKE $8 ESCAPE '\\'
       OR COALESCE(b.code, '') ILIKE $8 ESCAPE '\\'
     ORDER BY cs.archived ASC, cs.sku ASC, i.epc ASC
     LIMIT 200`,
    [
      tenantId,
      epcHex24,
      epcHex24 ? upperPartial : "",
      epcPartial && !epcHex24,
      epcPartial && !epcHex24 ? upperPartial : "",
      digitsOnly,
      digitsOnly ? raw : "",
      like,
    ],
  );

  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    description: row.description,
    color: row.color,
    size: row.size,
    upc: row.upc,
    vendor: row.vendor,
    status: row.status,
    location_code: row.location_code,
    bin_code: row.bin_code,
    archived: row.archived === true,
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

  // Always return pick rows — the new EPC tracker UI is table-first; row
  // click drills into the existing detail + history panel below.
  const matches = await searchEpcTrackerBroad(pool, tenantId, trimmed);
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
