/**
 * Canonical page/section tree for User Role permissions (JSONB in `user_roles.permissions`).
 * Shape: { [pageId]: { [sectionId]: "view" | "hide" } }. Omitted keys default to "view" in UI.
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
      { id: "locations_bins", label: "Locations & Bins" },
    ],
  },
  {
    id: "rfid",
    label: "RFID workflows",
    sections: [
      { id: "cycle_counts", label: "Cycle counts" },
      { id: "epc_tracker", label: "EPC tracker" },
      { id: "commissioning", label: "Print / Commission" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    sections: [
      { id: "exceptions", label: "Exceptions" },
      { id: "transfers", label: "Transfers" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory & sync",
    sections: [
      { id: "catalog", label: "Catalog" },
      { id: "lightspeed_sync", label: "Lightspeed sync" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    sections: [
      { id: "devices", label: "Devices" },
      { id: "ls_sales", label: "LS sales" },
      { id: "infra_settings", label: "Settings" },
      { id: "status_labels", label: "Status labels" },
      { id: "users_roles", label: "Users & roles" },
      { id: "location_settings", label: "Location settings" },
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
