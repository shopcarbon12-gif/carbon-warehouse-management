import type { Pool, PoolClient } from "pg";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";

export type StatusLabelRow = {
  id: number;
  legacy_id: number | null;
  name: string;
  display_label: string;
  is_sellable: boolean;
  is_visible_to_scanner: boolean;
  is_visible_in_ui: boolean;
  super_admin_locked: boolean;
  is_system_only: boolean;
  created_at: string;
  updated_at: string;
};

export async function listStatusLabels(pool: Pool): Promise<StatusLabelRow[]> {
  const r = await pool.query<{
    id: number;
    legacy_id: number | null;
    name: string;
    display_label: string;
    is_sellable: boolean;
    is_visible_to_scanner: boolean;
    is_visible_in_ui: boolean;
    super_admin_locked: boolean;
    is_system_only: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, legacy_id, name, display_label,
            is_sellable, is_visible_to_scanner, is_visible_in_ui,
            super_admin_locked, is_system_only,
            created_at, updated_at
     FROM status_labels
     ORDER BY legacy_id NULLS LAST, name ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    legacy_id: row.legacy_id,
    name: row.name,
    display_label: row.display_label ?? "",
    is_sellable: row.is_sellable,
    is_visible_to_scanner: row.is_visible_to_scanner,
    is_visible_in_ui: row.is_visible_in_ui,
    super_admin_locked: row.super_admin_locked,
    is_system_only: row.is_system_only,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

/** Resolve label row for an `items.status` value (WMS side). */
export async function getStatusLabelForWmsItemStatus(
  pool: Pool | PoolClient,
  wmsItemStatus: string,
): Promise<StatusLabelRow | null> {
  const labelName = labelNameForWmsStatus(wmsItemStatus);
  const r = await pool.query<{
    id: number;
    legacy_id: number | null;
    name: string;
    display_label: string;
    is_sellable: boolean;
    is_visible_to_scanner: boolean;
    is_visible_in_ui: boolean;
    super_admin_locked: boolean;
    is_system_only: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, legacy_id, name, display_label,
            is_sellable, is_visible_to_scanner, is_visible_in_ui,
            super_admin_locked, is_system_only,
            created_at, updated_at
     FROM status_labels
     WHERE lower(trim(name)) = lower(trim($1))
     LIMIT 1`,
    [labelName],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    legacy_id: row.legacy_id,
    name: row.name,
    display_label: row.display_label ?? "",
    is_sellable: row.is_sellable,
    is_visible_to_scanner: row.is_visible_to_scanner,
    is_visible_in_ui: row.is_visible_in_ui,
    super_admin_locked: row.super_admin_locked,
    is_system_only: row.is_system_only,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function updateStatusLabelPresentation(
  pool: Pool,
  id: number,
  input: { display_label: string; legacy_id: number | null },
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE status_labels
     SET display_label = $2::text,
         legacy_id = $3::int,
         updated_at = now()
     WHERE id = $1::int`,
    [id, input.display_label.trim(), input.legacy_id],
  );
  return (r.rowCount ?? 0) > 0;
}
