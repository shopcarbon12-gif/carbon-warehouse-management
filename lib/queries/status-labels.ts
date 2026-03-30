import type { Pool } from "pg";

export type StatusLabelRow = {
  id: number;
  legacy_id: number | null;
  name: string;
  display_label: string;
  include_in_inventory: boolean;
  hide_in_search_filters: boolean;
  hide_in_item_details: boolean;
  display_in_group_page: boolean;
  auto_display_if_tags_present: boolean;
  allow_instant_stolen_api: boolean;
  prevent_live_on_transfer_receive: boolean;
  prevent_change_during_audit_request: boolean;
  prevent_live_after_inventory_upload_script: boolean;
  created_at: string;
  updated_at: string;
};

export async function listStatusLabels(pool: Pool): Promise<StatusLabelRow[]> {
  const r = await pool.query<{
    id: number;
    legacy_id: number | null;
    name: string;
    display_label: string;
    include_in_inventory: boolean;
    hide_in_search_filters: boolean;
    hide_in_item_details: boolean;
    display_in_group_page: boolean;
    auto_display_if_tags_present: boolean;
    allow_instant_stolen_api: boolean;
    prevent_live_on_transfer_receive: boolean;
    prevent_change_during_audit_request: boolean;
    prevent_live_after_inventory_upload_script: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, legacy_id, name, display_label, include_in_inventory, hide_in_search_filters,
            hide_in_item_details, display_in_group_page, auto_display_if_tags_present,
            allow_instant_stolen_api, prevent_live_on_transfer_receive,
            prevent_change_during_audit_request, prevent_live_after_inventory_upload_script,
            created_at, updated_at
     FROM status_labels
     ORDER BY legacy_id NULLS LAST, name ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    legacy_id: row.legacy_id,
    name: row.name,
    display_label: row.display_label,
    include_in_inventory: row.include_in_inventory,
    hide_in_search_filters: row.hide_in_search_filters,
    hide_in_item_details: row.hide_in_item_details,
    display_in_group_page: row.display_in_group_page,
    auto_display_if_tags_present: row.auto_display_if_tags_present,
    allow_instant_stolen_api: row.allow_instant_stolen_api,
    prevent_live_on_transfer_receive: row.prevent_live_on_transfer_receive,
    prevent_change_during_audit_request: row.prevent_change_during_audit_request,
    prevent_live_after_inventory_upload_script: row.prevent_live_after_inventory_upload_script,
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

export type StatusLabelWriteInput = {
  legacy_id: number | null;
  name: string;
  display_label: string;
  include_in_inventory: boolean;
  hide_in_search_filters: boolean;
  hide_in_item_details: boolean;
  display_in_group_page: boolean;
  auto_display_if_tags_present: boolean;
  allow_instant_stolen_api: boolean;
  prevent_live_on_transfer_receive: boolean;
  prevent_change_during_audit_request: boolean;
  prevent_live_after_inventory_upload_script: boolean;
};

export async function insertStatusLabel(
  pool: Pool,
  input: StatusLabelWriteInput,
): Promise<{ ok: true; id: number } | { ok: false; code: "duplicate_name" | "duplicate_legacy" }> {
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO status_labels (
         legacy_id, name, display_label,
         include_in_inventory, hide_in_search_filters, hide_in_item_details, display_in_group_page,
         auto_display_if_tags_present, allow_instant_stolen_api,
         prevent_live_on_transfer_receive, prevent_change_during_audit_request,
         prevent_live_after_inventory_upload_script
       )
       VALUES ($1::int, $2, $3, $4::boolean, $5::boolean, $6::boolean, $7::boolean,
               $8::boolean, $9::boolean, $10::boolean, $11::boolean, $12::boolean)
       RETURNING id`,
      [
        input.legacy_id,
        input.name.trim(),
        input.display_label.trim(),
        input.include_in_inventory,
        input.hide_in_search_filters,
        input.hide_in_item_details,
        input.display_in_group_page,
        input.auto_display_if_tags_present,
        input.allow_instant_stolen_api,
        input.prevent_live_on_transfer_receive,
        input.prevent_change_during_audit_request,
        input.prevent_live_after_inventory_upload_script,
      ],
    );
    const id = r.rows[0]?.id;
    if (id == null) throw new Error("insertStatusLabel: missing id");
    return { ok: true, id };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      const msg = String((e as { detail?: string }).detail ?? "");
      if (/legacy_id/i.test(msg)) return { ok: false, code: "duplicate_legacy" };
      return { ok: false, code: "duplicate_name" };
    }
    throw e;
  }
}

export async function updateStatusLabelFull(
  pool: Pool,
  id: number,
  input: StatusLabelWriteInput,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "duplicate_name" | "duplicate_legacy" }> {
  const dup = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM status_labels WHERE lower(name) = lower($1) AND id <> $2::int`,
    [input.name.trim(), id],
  );
  if (Number(dup.rows[0]?.c ?? 0) > 0) {
    return { ok: false, code: "duplicate_name" };
  }
  if (input.legacy_id != null) {
    const dupL = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM status_labels WHERE legacy_id = $1::int AND id <> $2::int`,
      [input.legacy_id, id],
    );
    if (Number(dupL.rows[0]?.c ?? 0) > 0) {
      return { ok: false, code: "duplicate_legacy" };
    }
  }
  const r = await pool.query(
    `UPDATE status_labels SET
       legacy_id = $2::int,
       name = $3,
       display_label = $4,
       include_in_inventory = $5::boolean,
       hide_in_search_filters = $6::boolean,
       hide_in_item_details = $7::boolean,
       display_in_group_page = $8::boolean,
       auto_display_if_tags_present = $9::boolean,
       allow_instant_stolen_api = $10::boolean,
       prevent_live_on_transfer_receive = $11::boolean,
       prevent_change_during_audit_request = $12::boolean,
       prevent_live_after_inventory_upload_script = $13::boolean,
       updated_at = now()
     WHERE id = $1::int`,
    [
      id,
      input.legacy_id,
      input.name.trim(),
      input.display_label.trim(),
      input.include_in_inventory,
      input.hide_in_search_filters,
      input.hide_in_item_details,
      input.display_in_group_page,
      input.auto_display_if_tags_present,
      input.allow_instant_stolen_api,
      input.prevent_live_on_transfer_receive,
      input.prevent_change_during_audit_request,
      input.prevent_live_after_inventory_upload_script,
    ],
  );
  if ((r.rowCount ?? 0) === 0) return { ok: false, code: "not_found" };
  return { ok: true };
}

export async function deleteStatusLabelById(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query(`DELETE FROM status_labels WHERE id = $1::int`, [id]);
  return (r.rowCount ?? 0) > 0;
}
