/**
 * WMS Mobile (handheld app) permission catalog.
 *
 * Enumerates every screen in the Carbon WMS Flutter app, grouped into the
 * same hub structure the app's navigation uses. Mirrors the shape of
 * APP_PERMISSION_PAGES (web) / POS_PERMISSION_PAGES so the role editor and
 * PermissionsMap helpers in permission-catalog.ts are reused AS-IS — every
 * toggle is still a plain "view" | "hide" section.
 *
 * GRANULARITY (2026-06-05): screen-level visibility was the only control
 * before. We now express three more dimensions WITHOUT changing the value
 * shape (still view/hide), by adding extra "sections" with a naming
 * convention that the mobile app interprets:
 *
 *   <screenId>                → the screen itself (hide = screen not shown)
 *   <screenId>__edit          → "allow edits" (hide = screen is READ-ONLY)
 *   <screenId>__<actionId>    → a specific action (hide = that button denied)
 *   show_<field>              → a sensitive field (hide = field concealed)
 *
 * Defaults: a missing/"view" section = allowed/visible (full access), matching
 * the empty-`{}` = full-access convention. So an admin only flips the few
 * things a role should NOT have. `login`/`device_lock` are never listed — they
 * must always be reachable.
 *
 * Mobile mapping (mobile_permissions.dart):
 *   canView(s)        = !hidden(s)
 *   canEdit(s)        = canView(s) && !hidden(`${s}__edit`)
 *   canDo(s, a)       = canEdit(s) && !hidden(`${s}__${a}`)
 *   showField(flag)   = !hidden(flag)
 */

import type { PermissionPageDef, PermissionSectionDef } from "./permission-catalog";

/** A screen + its optional edit-capability and per-action gates. */
type MobileScreenDef = {
  id: string;
  label: string;
  /** Adds a "<label> · allow edits" toggle (read-only vs edit) when true. */
  editable?: boolean;
  /** Per-action perform toggles, rendered as "<label> · allow <action>". */
  actions?: { id: string; label: string }[];
};

type MobileGroupDef = { id: string; label: string; screens: MobileScreenDef[] };

/** Sensitive fields that can be hidden role-wide (the "who sees cost" switches). */
export const MOBILE_FIELD_FLAGS = [
  { id: "show_cost", label: "Item cost / wholesale / margin" },
  { id: "show_retail_price", label: "Retail price" },
  { id: "show_vendor", label: "Vendor / supplier" },
  { id: "show_on_hand", label: "On-hand quantity" },
  { id: "show_system_ids", label: "System IDs / serials" },
  { id: "show_actor_names", label: "Operator names (in reports)" },
] as const;

const MOBILE_GROUPS: MobileGroupDef[] = [
  {
    id: "home",
    label: "Home",
    screens: [{ id: "dashboard", label: "Dashboard" }],
  },
  {
    id: "inventory",
    label: "Inventory",
    screens: [
      { id: "inventory_hub", label: "Inventory hub" },
      { id: "inventory_catalog", label: "Catalog" },
      { id: "inventory_lookup", label: "Item lookup" },
      {
        id: "count_inventory",
        label: "Count inventory",
        editable: true,
        actions: [
          { id: "upload", label: "Upload count" },
          { id: "save", label: "Save count" },
          { id: "export_csv", label: "Export CSV" },
          { id: "delete_item", label: "Delete scanned item" },
        ],
      },
      {
        id: "add_on_catalog",
        label: "Add-on catalog (scan unknowns)",
        editable: true,
        actions: [
          { id: "upload", label: "Upload" },
          { id: "export_csv", label: "Export CSV" },
        ],
      },
      { id: "inventory_csv_session", label: "CSV import session", editable: true },
    ],
  },
  {
    id: "add_on_count",
    label: "Add-On Count",
    screens: [
      {
        id: "add_on_count_source_picker",
        label: "Add-on count — source",
        editable: true,
        actions: [
          { id: "start_session", label: "Start session" },
          { id: "reopen_completed", label: "Re-open completed" },
        ],
      },
      { id: "add_on_count", label: "Add-on count — scan", editable: true },
      {
        id: "add_on_count_review",
        label: "Add-on count — review",
        editable: true,
        actions: [
          { id: "upload", label: "Upload" },
          { id: "save", label: "Save" },
        ],
      },
      { id: "add_on_count_settings", label: "Add-on count — settings", editable: true },
    ],
  },
  {
    id: "bin",
    label: "Bin Management",
    screens: [
      {
        id: "fast_putaway",
        label: "Bin Assign",
        editable: true,
        actions: [
          { id: "create_bin", label: "Create bin" },
          { id: "clean_bin", label: "Clean bin" },
          { id: "delete_bin", label: "Delete bin" },
        ],
      },
      {
        id: "clean_bin",
        label: "Clean Bin",
        editable: true,
        actions: [{ id: "clean_empty_bin", label: "Clean & empty bin" }],
      },
      { id: "bin_assign_settings", label: "Bin assign settings", editable: true },
      { id: "epc_detail", label: "EPC detail" },
    ],
  },
  {
    id: "encode_print",
    label: "Encode & Print",
    screens: [
      { id: "encode", label: "Encode", editable: true },
      { id: "encode_and_print", label: "Encode & Print", editable: true },
      { id: "encode_test_tag", label: "Test encoded tag" },
      {
        id: "search_and_encode",
        label: "Re-Encode",
        editable: true,
        actions: [{ id: "change_extract_settings", label: "Change extract settings" }],
      },
      {
        id: "print",
        label: "Print RFID",
        editable: true,
        actions: [{ id: "commission_rfid", label: "Commission RFID + add to inventory" }],
      },
      { id: "print_non_rfid", label: "Print Non-RFID", editable: true },
      { id: "barcode_intake", label: "Barcode intake", editable: true },
      { id: "status_change", label: "Status change — scan", editable: true },
      {
        id: "status_pick",
        label: "Status change — commit",
        editable: true,
        actions: [{ id: "override_risky", label: "Override risky transitions" }],
      },
    ],
  },
  {
    id: "find",
    label: "Find Tags",
    screens: [
      { id: "geiger_search", label: "Geiger search" },
      {
        id: "cloud_geiger",
        label: "Cloud + Geiger",
        editable: true,
        actions: [
          { id: "dismiss_all", label: "Dismiss all" },
          { id: "export_csv", label: "Export CSV" },
        ],
      },
      { id: "locate_tag", label: "Locate tag (Geiger)" },
    ],
  },
  {
    id: "transfers",
    label: "Transfers",
    screens: [
      {
        id: "transfer_out",
        label: "Transfer Out",
        editable: true,
        actions: [
          { id: "commit_transfer", label: "Send transfer" },
          { id: "print_slip", label: "Print slip" },
        ],
      },
      { id: "transfer_in_pending", label: "Transfer In — pending" },
      {
        id: "transfer_in_receive",
        label: "Transfer In — receive",
        editable: true,
        actions: [{ id: "commit_receive", label: "Receive into stock" }],
      },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    screens: [
      { id: "reports_hub", label: "Reports hub" },
      { id: "count_reports", label: "Count reports", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "status_reports", label: "Status reports", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "damages_reports", label: "Damages reports", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "re_encode_reports", label: "Re-encode reports", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "transfer_out_reports", label: "Transfer reports", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "bin_clearance_report", label: "Bin clearance report" },
      { id: "encode_commission_report", label: "Encode-commission report", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "add_on_catalog_report", label: "Add-on catalog report", actions: [{ id: "export_csv", label: "Export CSV" }] },
      { id: "label_print_report", label: "Label print report", actions: [{ id: "export_csv", label: "Export CSV" }] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    screens: [
      {
        id: "handheld_settings",
        label: "Handheld settings",
        editable: true,
        actions: [
          { id: "set_antenna_power", label: "Change antenna power" },
          { id: "set_scanner_source", label: "Change scanner source" },
          { id: "toggle_biometric", label: "Toggle biometric sign-in" },
        ],
      },
    ],
  },
];

/** Flatten a screen into its view/hide sections (screen + edit + actions). */
function expandScreens(screens: MobileScreenDef[]): PermissionSectionDef[] {
  const out: PermissionSectionDef[] = [];
  for (const s of screens) {
    out.push({ id: s.id, label: s.label });
    if (s.editable) out.push({ id: `${s.id}__edit`, label: `${s.label} · allow edits` });
    for (const a of s.actions ?? []) {
      out.push({ id: `${s.id}__${a.id}`, label: `${s.label} · allow ${a.label}` });
    }
  }
  return out;
}

export const MOBILE_PERMISSION_PAGES: readonly PermissionPageDef[] = [
  ...MOBILE_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    sections: expandScreens(g.screens),
  })),
  {
    id: "data_visibility",
    label: "Data visibility — set Hide to conceal a field from this role",
    sections: MOBILE_FIELD_FLAGS.map((f) => ({ id: f.id, label: f.label })),
  },
] as const;
