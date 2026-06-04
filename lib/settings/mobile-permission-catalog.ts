/**
 * WMS Mobile (handheld app) permission catalog.
 *
 * Enumerates every screen in the Carbon WMS Flutter app, grouped into the
 * same hub structure the app's navigation uses. Mirrors the shape of
 * APP_PERMISSION_PAGES (web) / POS_PERMISSION_PAGES so the role editor and
 * PermissionsMap helpers in permission-catalog.ts can be reused as-is.
 *
 * A role's stored permission map marks each screen "view" or "hide". Empty
 * (or missing) = "view" (full access) — same convention as POS/Rewards, which
 * is why a Super Admin with `{}` permissions sees everything.
 *
 * Screen ids match the Flutter screen files (mobile/carbon_wms/lib/ui/screens)
 * minus the `_screen.dart` suffix, so Phase 2 (in-app enforcement) can key
 * route guards off these ids directly. `login` and `device_lock` are
 * intentionally NOT listed — they must always be reachable.
 */

import type { PermissionPageDef } from "./permission-catalog";

export const MOBILE_PERMISSION_PAGES: readonly PermissionPageDef[] = [
  {
    id: "home",
    label: "Home",
    sections: [{ id: "dashboard", label: "Dashboard" }],
  },
  {
    id: "inventory",
    label: "Inventory",
    sections: [
      { id: "inventory_hub", label: "Inventory hub" },
      { id: "inventory_catalog", label: "Catalog" },
      { id: "inventory_lookup", label: "Item lookup" },
      { id: "count_inventory", label: "Count inventory" },
      { id: "fast_putaway", label: "Fast putaway" },
      { id: "clean_bin", label: "Clean bin" },
      { id: "bin_assign_settings", label: "Bin assign" },
      { id: "inventory_csv_session", label: "CSV import session" },
    ],
  },
  {
    id: "add_on_count",
    label: "Add-On Count",
    sections: [
      { id: "add_on_count", label: "Add-on count" },
      { id: "add_on_count_source_picker", label: "Add-on count — source" },
      { id: "add_on_count_review", label: "Add-on count — review" },
      { id: "add_on_count_settings", label: "Add-on count — settings" },
    ],
  },
  {
    id: "transfers",
    label: "Transfers",
    sections: [
      { id: "transfer_slips", label: "Transfer slips" },
      { id: "transfer_in_pending", label: "Transfer in — pending" },
      { id: "transfer_in_receive", label: "Transfer in — receive" },
      { id: "transfer_out_reports", label: "Transfer out — reports" },
      { id: "transfer_reports_hub", label: "Transfer reports hub" },
    ],
  },
  {
    id: "encode_print",
    label: "Encode & Print",
    sections: [
      { id: "encode", label: "Encode" },
      { id: "encode_suite", label: "Encode suite" },
      { id: "encode_test_tag", label: "Encode test tag" },
      { id: "search_and_encode", label: "Search & encode" },
      { id: "print", label: "Print RFID" },
      { id: "print_non_rfid", label: "Print Non-RFID" },
      { id: "barcode_intake", label: "Barcode intake" },
      { id: "status_change", label: "Status change" },
    ],
  },
  {
    id: "find",
    label: "Find Tags",
    sections: [
      { id: "geiger_search", label: "Geiger search" },
      { id: "cloud_geiger", label: "Cloud geiger" },
      { id: "locate_tag", label: "Locate tag" },
      { id: "epc_detail", label: "EPC detail" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    sections: [
      { id: "reports_hub", label: "Reports hub" },
      { id: "count_reports", label: "Count reports" },
      { id: "status_reports", label: "Status reports" },
      { id: "damages_reports", label: "Damages reports" },
      { id: "re_encode_reports", label: "Re-encode reports" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    sections: [{ id: "handheld_settings", label: "Handheld settings" }],
  },
] as const;
