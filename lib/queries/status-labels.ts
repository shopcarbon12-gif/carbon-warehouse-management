import type { Pool } from "pg";

export type StatusLabelRow = {
  id: number;
  legacy_id: number | null;
  name: string;
  include_in_inventory: boolean;
  hide_in_search_filters: boolean;
  hide_in_item_details: boolean;
  display_in_group_page: boolean;
  created_at: string;
  updated_at: string;
};

export async function listStatusLabels(pool: Pool): Promise<StatusLabelRow[]> {
  const r = await pool.query<{
    id: number;
    legacy_id: number | null;
    name: string;
    include_in_inventory: boolean;
    hide_in_search_filters: boolean;
    hide_in_item_details: boolean;
    display_in_group_page: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, legacy_id, name, include_in_inventory, hide_in_search_filters,
            hide_in_item_details, display_in_group_page, created_at, updated_at
     FROM status_labels
     ORDER BY id ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    legacy_id: row.legacy_id,
    name: row.name,
    include_in_inventory: row.include_in_inventory,
    hide_in_search_filters: row.hide_in_search_filters,
    hide_in_item_details: row.hide_in_item_details,
    display_in_group_page: row.display_in_group_page,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

export type StatusLabelBooleanKey =
  | "include_in_inventory"
  | "hide_in_search_filters"
  | "hide_in_item_details"
  | "display_in_group_page";

const BOOL_COL: Record<StatusLabelBooleanKey, string> = {
  include_in_inventory: "include_in_inventory",
  hide_in_search_filters: "hide_in_search_filters",
  hide_in_item_details: "hide_in_item_details",
  display_in_group_page: "display_in_group_page",
};

export async function updateStatusLabelBoolean(
  pool: Pool,
  id: number,
  key: StatusLabelBooleanKey,
  value: boolean,
): Promise<boolean> {
  const col = BOOL_COL[key];
  const r = await pool.query(
    `UPDATE status_labels SET ${col} = $2::boolean, updated_at = now() WHERE id = $1::int`,
    [id, value],
  );
  return (r.rowCount ?? 0) > 0;
}
