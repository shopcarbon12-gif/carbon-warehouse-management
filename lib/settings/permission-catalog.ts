/**
 * Canonical page/section tree for User Role permissions (JSONB in `user_roles.permissions`).
 * Shape: { [pageId]: { [sectionId]: "view" | "hide" } }. Omitted keys default to "view" in UI.
 *
 * 2026-05-28 audit: realigned to actual `/app/(main)/*` routes. Was missing
 * most of: bulk import / bulk status / encode items, the full reports tree,
 * the loyalty tree, antenna test, hardware config, settings sub-pages
 * (epc-profiles, theme, updates, statuses, handheld), alerts, orders.
 * Every section here maps to a real URL the WMS serves today.
 */

export type PermissionMode = "view" | "hide";

export type PermissionSectionDef = { id: string; label: string };
export type PermissionPageDef = { id: string; label: string; sections: PermissionSectionDef[] };

export const APP_PERMISSION_PAGES: PermissionPageDef[] = [
  {
    id: "overview",
    label: "Overview",
    sections: [
      { id: "dashboard", label: "Dashboard" },
      { id: "locations", label: "Locations / overview" },
      { id: "alerts", label: "Alerts" },
    ],
  },
  {
    id: "rfid",
    label: "RFID workflows",
    sections: [
      { id: "cycle_counts", label: "Cycle counts" },
      { id: "epc_tracker", label: "EPC tracker" },
      { id: "commissioning", label: "Print tags" },
      { id: "encode_items", label: "Encode Items (re-encode chip)" },
      { id: "antenna_test", label: "Antenna Test (diagnostic)" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    sections: [
      { id: "inventory_home", label: "Inventory home" },
      { id: "bulk_import", label: "Bulk Import (new EPCs)" },
      { id: "bulk_status", label: "Bulk Status update" },
      { id: "catalog", label: "Catalog" },
      { id: "compare", label: "Inventory compare" },
      { id: "transfers_in", label: "Transfers In" },
      { id: "transfers_out", label: "Transfers Out" },
      { id: "sync", label: "Lightspeed / Sync" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    sections: [
      { id: "exceptions", label: "Exceptions" },
      { id: "transfers", label: "Transfers (operations)" },
      { id: "transfers_in", label: "Transfers In (ops)" },
      { id: "transfers_out", label: "Transfers Out (ops)" },
      { id: "orders", label: "Orders" },
    ],
  },
  {
    id: "loyalty",
    label: "Loyalty",
    sections: [
      { id: "loyalty_home", label: "Loyalty home" },
      { id: "customers", label: "Customers list" },
      { id: "customer_new", label: "Add customer" },
      { id: "customer_import", label: "Import customers (CSV)" },
      { id: "customer_edit", label: "Edit customer (detail page)" },
      { id: "ledger", label: "Points ledger" },
      { id: "rewards", label: "Rewards catalog" },
      { id: "tiers", label: "Tiers" },
      { id: "referrals", label: "Referrals" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    sections: [
      { id: "activity", label: "Activity" },
      { id: "adjustments", label: "Adjustments" },
      { id: "asset_movements", label: "Asset movements" },
      { id: "bulk_imports", label: "Bulk imports" },
      { id: "count_sessions", label: "Count-session archive" },
      { id: "external_systems", label: "External systems" },
      { id: "inventory_compare", label: "Inventory compare" },
      { id: "replenishments", label: "Replenishments" },
      { id: "status_logs", label: "Status logs" },
      { id: "transfers_in", label: "Transfers In" },
      { id: "transfers_out", label: "Transfers Out" },
      { id: "uploads", label: "Uploads" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    sections: [
      { id: "devices", label: "Devices" },
      { id: "hardware_config", label: "Hardware Config (readers / antennas)" },
      { id: "handheld", label: "Handheld bindings" },
      { id: "ls_sales", label: "Lightspeed sales feed" },
      { id: "integrations", label: "Integrations" },
      { id: "infra_settings", label: "Infrastructure settings" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    sections: [
      { id: "general", label: "General" },
      { id: "users_roles", label: "Users & roles" },
      { id: "locations", label: "Locations" },
      { id: "devices", label: "Devices (settings)" },
      { id: "handheld", label: "Handheld" },
      { id: "epc_profiles", label: "EPC profiles" },
      { id: "statuses", label: "Status labels" },
      { id: "theme", label: "Theme" },
      { id: "updates", label: "Mobile updates (APK)" },
    ],
  },
];

export type PermissionsMap = Record<string, Record<string, PermissionMode>>;

export function emptyPermissionsMap(): PermissionsMap {
  return {};
}

export function getSectionMode(
  permissions: PermissionsMap | null | undefined,
  pageId: string,
  sectionId: string,
): PermissionMode {
  const p = permissions?.[pageId]?.[sectionId];
  return p === "hide" ? "hide" : "view";
}

export function setSectionMode(
  permissions: PermissionsMap,
  pageId: string,
  sectionId: string,
  mode: PermissionMode,
): PermissionsMap {
  const next: PermissionsMap = { ...permissions };
  const page = { ...(next[pageId] ?? {}) };
  page[sectionId] = mode;
  next[pageId] = page;
  return next;
}
