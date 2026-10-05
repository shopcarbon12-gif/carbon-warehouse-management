/**
 * Plain-English names for everything the Activity history shows.
 *
 * `api_request` rows (written by `withActivity`) carry a route pattern such as
 * `inventory/catalog/matrices/[id]` plus the HTTP method; older rows carry an
 * `action` such as `cdm_reader_pause_all`. Both resolve here to a module and a
 * sentence a person would say ("Edited product", "Paused all readers").
 */

export const ACTIVITY_MODULES = [
  "Sign-in",
  "Catalog",
  "Studio",
  "Shopify",
  "Shopify orders",
  "Inventory status",
  "Stock adjustments",
  "Inventory",
  "Counts",
  "Transfers",
  "Shipping",
  "Tags & labels",
  "Bins & locations",
  "Handheld",
  "Readers & hardware",
  "Reader movements",
  "Users & access",
  "Settings",
  "Lightspeed",
  "Exceptions",
  "Reports",
  "Other",
] as const;
export type ActivityModule = (typeof ACTIVITY_MODULES)[number];

type Entry = { module: ActivityModule; label: string | Partial<Record<string, string>> };

/** Route pattern → module + label (string, or per HTTP method). */
const ROUTES: Record<string, Entry> = {
  "auth/login": { module: "Sign-in", label: "Sign-in" },
  "auth/logout": { module: "Sign-in", label: "Signed out" },
  "session/location": { module: "Sign-in", label: "Switched location" },

  "inventory/catalog/matrices/[id]": {
    module: "Catalog",
    label: { PATCH: "Edited product", POST: "Added a variant", DELETE: "Deleted product" },
  },
  "inventory/catalog/matrices/[id]/variant-order": { module: "Catalog", label: "Reordered sizes / variants" },
  "inventory/catalog/custom-skus/[id]": {
    module: "Catalog",
    label: { PATCH: "Edited variant (SKU)", DELETE: "Deleted variant (SKU)", POST: "Changed variant (SKU)" },
  },
  "inventory/catalog/manual": { module: "Catalog", label: "Added catalog item by hand" },
  "inventory/catalog/manual-items": { module: "Stock adjustments", label: "Changed non-RFID quantity" },
  "inventory/catalog/manual-items/[customSkuId]/override": { module: "Stock adjustments", label: "Overrode non-RFID quantity" },
  "inventory/catalog/import-csv": { module: "Catalog", label: "Imported catalog CSV" },
  "inventory/catalog/defective-epcs": { module: "Inventory status", label: "Dismissed defective tags" },
  "inventory/categories/[id]": { module: "Catalog", label: { PATCH: "Edited category", DELETE: "Deleted category", POST: "Changed category" } },
  "inventory/size-grading": { module: "Catalog", label: "Saved size grading" },
  "inventory/size-grading/ai-read": { module: "Catalog", label: "Measured garment from photo" },
  "collection-mapping": { module: "Shopify", label: "Changed collection mapping" },

  "generate": { module: "Studio", label: "Generated Studio panel" },
  "studio/color-run": { module: "Studio", label: { PUT: "Saved colourway run", DELETE: "Deleted colourway run", POST: "Started colourway run" } },
  "openai/item-spec": { module: "Studio", label: "Analysed item photos" },
  "openai/color-check": { module: "Studio", label: "Checked colourway photo" },
  "openai/image-alt": { module: "Studio", label: "Wrote image alt text" },
  "models/upload": { module: "Studio", label: "Uploaded model photo" },

  "shopify/publish": { module: "Shopify", label: "Published to Shopify" },
  "shopify/status": { module: "Shopify", label: "Changed Shopify product status" },
  "shopify/media": { module: "Shopify", label: { POST: "Changed Shopify images", PUT: "Changed Shopify images", PATCH: "Reordered Shopify images", DELETE: "Deleted Shopify image" } },
  "shopify/image-upload": { module: "Shopify", label: "Uploaded image to Shopify" },
  "shopify/metafields": { module: "Shopify", label: "Edited Shopify metafields" },
  "shopify/link": { module: "Shopify", label: "Linked product to Shopify" },
  "shopify/link/all": { module: "Shopify", label: "Linked all products to Shopify" },
  "shopify/inventory-sync": { module: "Shopify", label: "Synced stock to Shopify" },
  "shopify/sync/trigger": { module: "Shopify", label: "Started Shopify sync" },
  "shopify/seo/optimize": { module: "Shopify", label: "Wrote SEO with AI" },
  "shopify/seo/write": { module: "Shopify", label: "Saved SEO to Shopify" },
  "shopify/seo/audit": { module: "Shopify", label: "Ran SEO audit" },
  "shopify/set-banner": { module: "Shopify", label: "Set store banner" },
  "shopify/collections/create": { module: "Shopify", label: "Created Shopify collection" },
  "shopify/collection-mapping": { module: "Shopify", label: "Changed collection mapping" },
  "shopify/category-attributes": { module: "Shopify", label: "Set Shopify category attributes" },
  "webhooks/shopify/orders-paid": { module: "Shopify orders", label: "Shopify order paid" },
  "webhooks/shopify/refunds-create": { module: "Shopify orders", label: "Shopify refund" },
  "webhooks/shopify/orders-cancelled": { module: "Shopify orders", label: "Shopify order cancelled — thank-you code expired" },
  "webhooks/shopify/orders-fulfilled": { module: "Shopify orders", label: "Shopify order fulfilled — unknown tags back to live" },

  "inventory/bulk-status": { module: "Inventory status", label: "Changed tag status" },
  "mobile/epc-visibility": { module: "Inventory status", label: "Changed tag visibility" },
  "inventory/bulk-import/commit": { module: "Inventory", label: "Committed bulk import" },
  "inventory/bulk-import/scan": { module: "Inventory", label: "Scanned bulk import" },
  "inventory/upload": { module: "Inventory", label: "Uploaded inventory" },
  "inventory/putaway-assign": { module: "Bins & locations", label: "Assigned put-away bin" },
  "inventory/sync/preview": { module: "Lightspeed", label: "Previewed inventory sync" },
  "inventory/sync/preview/[token]/apply": { module: "Lightspeed", label: "Applied inventory sync" },
  "inventory/sync/trigger": { module: "Lightspeed", label: "Started inventory sync" },
  "sync/jobs": { module: "Lightspeed", label: "Queued sync job" },
  "integrations/lightspeed/pull": { module: "Lightspeed", label: "Pulled from Lightspeed" },
  "integrations/lightspeed/push": { module: "Lightspeed", label: "Pushed to Lightspeed" },
  "integrations/lightspeed/slip-transfer-add-items": { module: "Transfers", label: "Added items to Lightspeed transfer" },
  "integrations/lightspeed/slip-transfer-send": { module: "Transfers", label: "Sent Lightspeed transfer" },
  "integrations/lightspeed/sync-slip-transfer": { module: "Transfers", label: "Synced Lightspeed transfer" },

  "rfid/cycle-counts/commit": { module: "Counts", label: "Committed cycle count" },
  "rfid/cycle-counts/sessions": { module: "Counts", label: "Started cycle count" },
  "rfid/cycle-counts/sessions/[id]": { module: "Counts", label: { PATCH: "Updated cycle count", DELETE: "Deleted cycle count", POST: "Updated cycle count" } },
  "rfid/cycle-counts/sessions/[id]/commit": { module: "Counts", label: "Committed cycle count" },
  "rfid/cycle-counts/sessions/[id]/scan": { module: "Counts", label: "Sent count scans" },
  "rfid/cycle-counts/sessions/[id]/manual-items": { module: "Counts", label: "Counted non-RFID items" },
  "rfid/cycle-counts/sessions/[id]/manual-items/finish": { module: "Counts", label: "Finished non-RFID count" },
  "reports/count-sessions": { module: "Counts", label: "Changed count report" },
  "handheld/add-on-sessions": { module: "Counts", label: "Started add-on count" },
  "handheld/add-on-sessions/[id]": { module: "Counts", label: { PATCH: "Updated add-on count", DELETE: "Deleted add-on count", POST: "Updated add-on count" } },
  "handheld/add-on-sessions/[id]/epc": { module: "Counts", label: "Add-on count scan" },
  "handheld/add-on-sessions/[id]/epcs": { module: "Counts", label: "Add-on count scans" },
  "handheld/add-on-sessions/[id]/join-request": { module: "Counts", label: "Asked to join add-on count" },
  "handheld/add-on-sessions/[id]/reopen": { module: "Counts", label: "Reopened add-on count" },
  "compare/runs": { module: "Counts", label: "Ran compare" },

  "operations/transfers/commit": { module: "Transfers", label: "Sent transfer" },
  "operations/transfers/receive": { module: "Transfers", label: "Received transfer" },
  "inventory/transfer-slips": { module: "Transfers", label: "Created transfer slip" },
  "inventory/transfer-slips/[slipNumber]": { module: "Transfers", label: { PATCH: "Edited transfer slip", DELETE: "Deleted transfer slip", POST: "Edited transfer slip" } },

  "rfid/ship-scan-out": { module: "Shipping", label: "Scanned out" },
  "rfid/ship-scan-out/reader": { module: "Shipping", label: "Scan-out reader started/stopped" },
  "rfid/ship-scan-out/undo": { module: "Shipping", label: "Undid a scan-out" },

  "rfid/commission": { module: "Tags & labels", label: "Commissioned tags" },
  "rfid/encode-claim": { module: "Tags & labels", label: "Encode — claimed EPC" },
  "rfid/encode-finalize": { module: "Tags & labels", label: "Encoded tag" },
  "rfid/encode-resolve": { module: "Tags & labels", label: "Encode — resolved item" },
  "rfid/encode-resolve-and-claim": { module: "Tags & labels", label: "Encode — resolved and claimed" },
  "rfid/encode-rollback": { module: "Tags & labels", label: "Encode — rolled back" },
  "rfid/reprint": { module: "Tags & labels", label: "Reprinted label" },
  "rfid/zero-out": { module: "Tags & labels", label: "Zeroed out RFID data" },
  "rfid/bulk-geiger/promote": { module: "Inventory status", label: "Bulk Geiger — promoted tags" },
  "printnode/print": { module: "Tags & labels", label: "Printed label" },
  "handheld/print-event": { module: "Tags & labels", label: "Printed label (handheld)" },
  "v1/rfid/encode-events": { module: "Tags & labels", label: "Encode event" },

  "locations/bins": { module: "Bins & locations", label: "Created bin" },
  "locations/bins/[id]": { module: "Bins & locations", label: { PATCH: "Edited bin", DELETE: "Deleted bin", POST: "Edited bin" } },
  "locations/bins/[id]/clean": { module: "Bins & locations", label: "Cleaned bin" },
  "locations/bins/[id]/sku/[sku]": { module: "Bins & locations", label: { DELETE: "Removed SKU from bin", POST: "Added SKU to bin", PATCH: "Changed SKU in bin" } },
  "locations/bins/move": { module: "Bins & locations", label: "Moved bin contents" },
  "mobile/clean-bin": { module: "Bins & locations", label: "Cleaned bin (handheld)" },
  "settings/ensure-orlando-bins": { module: "Bins & locations", label: "Created standard bins" },
  "zones": { module: "Bins & locations", label: "Created zone" },
  "zones/[id]": { module: "Bins & locations", label: { PATCH: "Edited zone", DELETE: "Deleted zone", POST: "Edited zone" } },

  "handheld/batches": { module: "Handheld", label: "Uploaded handheld scans" },
  "handheld/scan-finalize": { module: "Handheld", label: "Finished handheld scan" },
  "handhelds/epc-queue": { module: "Handheld", label: "Sent EPCs to handhelds" },
  "devices/[id]/epc-queue": { module: "Handheld", label: "Sent EPCs to a handheld" },
  "mobile/barcode-intake": { module: "Handheld", label: "Barcode intake" },
  "mobile/releases/set-active": { module: "Handheld", label: "Set active app version" },
  "mobile/upload-apk": { module: "Handheld", label: "Uploaded app version" },

  "hardware-config/readers": { module: "Readers & hardware", label: "Added reader" },
  "hardware-config/readers/[id]": { module: "Readers & hardware", label: { PATCH: "Edited reader", DELETE: "Deleted reader", POST: "Edited reader" } },
  "hardware-config/readers/[id]/pause": { module: "Readers & hardware", label: "Paused reader" },
  "hardware-config/readers/[id]/resume": { module: "Readers & hardware", label: "Resumed reader" },
  "hardware-config/readers/[id]/hard-reset": { module: "Readers & hardware", label: "Hard-reset reader" },
  "hardware-config/readers/[id]/schedule": { module: "Readers & hardware", label: "Changed reader schedule" },
  "hardware-config/readers/[id]/monsoon-driver": { module: "Readers & hardware", label: "Changed reader driver" },
  "hardware-config/readers/pause-all": { module: "Readers & hardware", label: "Paused all readers" },
  "hardware-config/readers/resume-all": { module: "Readers & hardware", label: "Resumed all readers" },
  "hardware-config/hard-reset": { module: "Readers & hardware", label: "Hard-reset reader computer" },
  "hardware-config/antennas": { module: "Readers & hardware", label: "Added antenna" },
  "hardware-config/antennas/[id]": { module: "Readers & hardware", label: { PATCH: "Edited antenna", DELETE: "Deleted antenna", POST: "Edited antenna" } },
  "hardware-config/antennas/[id]/behaviour": { module: "Readers & hardware", label: "Changed antenna behaviour" },
  "hardware-config/antennas/[id]/test": { module: "Readers & hardware", label: "Tested antenna" },
  "antenna-test/start": { module: "Readers & hardware", label: "Started antenna test" },
  "antenna-test/stop": { module: "Readers & hardware", label: "Stopped antenna test" },
  "antenna-test/update": { module: "Readers & hardware", label: "Updated antenna test" },
  "antenna-test/calibrate": { module: "Readers & hardware", label: "Calibrated antenna" },
  "antenna-test/calibrate/[id]": { module: "Readers & hardware", label: "Calibrated antenna" },
  "scan-sessions/start": { module: "Readers & hardware", label: "Woke reader for a scan" },
  "scan-sessions/stop": { module: "Readers & hardware", label: "Stopped reader scan" },
  "scan-sessions/end": { module: "Readers & hardware", label: "Ended reader scan" },
  "dashboard/live-scan/start": { module: "Readers & hardware", label: "Turned Live Scan on" },
  "dashboard/live-scan/stop": { module: "Readers & hardware", label: "Turned Live Scan off" },
  "cdm-agents": { module: "Readers & hardware", label: "Added reader computer" },
  "cdm-agents/[id]": { module: "Readers & hardware", label: { PATCH: "Edited reader computer", DELETE: "Deleted reader computer", POST: "Edited reader computer" } },
  "cdm-agents/[id]/live-scan/start": { module: "Readers & hardware", label: "Turned Live Scan on" },
  "cdm-agents/[id]/live-scan/stop": { module: "Readers & hardware", label: "Turned Live Scan off" },
  "cdm-agents/[id]/recover": { module: "Readers & hardware", label: "Asked reader computer to recover" },
  "cdm-agents/[id]/regenerate-token": { module: "Readers & hardware", label: "Regenerated reader computer key" },
  "cdm-agents/set-monsoon-driver": { module: "Readers & hardware", label: "Changed reader driver" },
  "infrastructure/devices": { module: "Readers & hardware", label: "Added device" },
  "infrastructure/devices/[id]": { module: "Readers & hardware", label: { PATCH: "Edited device", DELETE: "Deleted device", POST: "Edited device" } },
  "infrastructure/settings": { module: "Settings", label: "Changed infrastructure settings" },

  "settings/access/users": { module: "Users & access", label: "Added user" },
  "settings/access/users/[id]": { module: "Users & access", label: { PATCH: "Edited user", DELETE: "Deleted user", PUT: "Edited user", POST: "Edited user" } },
  "settings/access/users/[id]/mobile-role": { module: "Users & access", label: "Changed user's handheld role" },
  "settings/access/user-roles": { module: "Users & access", label: "Added role" },
  "settings/access/user-roles/[id]": { module: "Users & access", label: { PATCH: "Edited role permissions", DELETE: "Deleted role", PUT: "Edited role permissions", POST: "Edited role permissions" } },
  "settings/access/locations": { module: "Users & access", label: "Added location" },
  "settings/access/locations/[id]": { module: "Users & access", label: { PATCH: "Edited location", DELETE: "Deleted location", PUT: "Edited location", POST: "Edited location" } },
  "settings/access/locations/[id]/reset-password": { module: "Users & access", label: "Reset location password" },
  "settings/access/pos-users": { module: "Users & access", label: "Added POS user" },
  "settings/access/pos-users/[id]": { module: "Users & access", label: { PATCH: "Edited POS user", DELETE: "Deleted POS user", PUT: "Edited POS user", POST: "Edited POS user" } },
  "settings/access/rewards-users": { module: "Users & access", label: "Added rewards user" },
  "settings/access/rewards-users/[id]": { module: "Users & access", label: { PATCH: "Edited rewards user", DELETE: "Deleted rewards user", PUT: "Edited rewards user", POST: "Edited rewards user" } },
  "settings/status-labels": { module: "Settings", label: "Changed status labels" },
  "settings/tenant-settings": { module: "Settings", label: "Changed settings" },

  "exceptions": { module: "Exceptions", label: "Changed exception" },
  "operations/exceptions/resolve": { module: "Exceptions", label: "Resolved exception" },
  "operations/exceptions/simulate": { module: "Exceptions", label: "Simulated exception" },
};

/** Older `audit_log.action` values. */
const ACTIONS: Record<string, Entry> = {
  rfid_zone_change: { module: "Reader movements", label: "Tag moved zone" },
  item_live_transition: { module: "Inventory status", label: "Tag went live" },
  cdm_reader_resume: { module: "Readers & hardware", label: "Resumed reader" },
  cdm_reader_pause: { module: "Readers & hardware", label: "Paused reader" },
  cdm_hard_reset: { module: "Readers & hardware", label: "Hard-reset reader computer" },
  cdm_reader_pause_all: { module: "Readers & hardware", label: "Paused all readers" },
  cdm_reader_resume_all: { module: "Readers & hardware", label: "Resumed all readers" },
  cdm_reader_hard_reset: { module: "Readers & hardware", label: "Hard-reset reader" },
  cdm_reader_set_monsoon_driver: { module: "Readers & hardware", label: "Changed reader driver" },
  cdm_agent_auto_mac_bind: { module: "Readers & hardware", label: "Reader bound to its network bridge" },
  cdm_agent_auto_ip_update: { module: "Readers & hardware", label: "Reader IP address changed" },
  cdm_agent_recover_requested: { module: "Readers & hardware", label: "Asked reader computer to recover" },
  lightspeed_catalog_sync: { module: "Lightspeed", label: "Lightspeed catalog sync" },
  cycle_count_scan_start: { module: "Counts", label: "Started count scan" },
  cycle_count_scan_pause: { module: "Counts", label: "Paused count scan" },
  cycle_count_scan_cancel: { module: "Counts", label: "Cancelled count scan" },
  rfid_cycle_count: { module: "Counts", label: "Cycle count" },
  rfid_zero_out: { module: "Tags & labels", label: "Zeroed out RFID data" },
  rfid_transfer: { module: "Transfers", label: "Sent transfer" },
  rfid_transfer_received: { module: "Transfers", label: "Received transfer" },
  rfid_print: { module: "Tags & labels", label: "Printed label" },
  exception_state: { module: "Exceptions", label: "Changed exception" },
  bulk_import_commit: { module: "Inventory", label: "Committed bulk import" },
  thank_you_code_created: { module: "Shopify", label: "Created thank-you code (15% off next order)" },
  STATUS_CHANGE: { module: "Inventory status", label: "Changed tag status" },
  ADJUSTMENT: { module: "Stock adjustments", label: "Adjusted stock" },
  KILLED_TAG: { module: "Inventory status", label: "Killed tag" },
  RESOLVED_KILLED_TAG: { module: "Inventory status", label: "Resolved killed tag" },
  BULK_IMPORT: { module: "Inventory", label: "Bulk import" },
};

function pick(e: Entry, method: string): string {
  if (typeof e.label === "string") return e.label;
  return e.label[method] ?? Object.values(e.label)[0] ?? method;
}

function guessModule(route: string): ActivityModule {
  const r = route;
  if (r.startsWith("shopify/")) return "Shopify";
  if (r.startsWith("settings/access")) return "Users & access";
  if (r.startsWith("settings/")) return "Settings";
  if (/^(hardware-config|cdm-agents|antenna-test|scan-sessions|infrastructure|devices)\//.test(r)) return "Readers & hardware";
  if (r.startsWith("rfid/cycle-counts") || r.startsWith("handheld/add-on")) return "Counts";
  if (r.startsWith("rfid/")) return "Tags & labels";
  if (r.startsWith("handheld") || r.startsWith("mobile/")) return "Handheld";
  if (r.startsWith("inventory/catalog")) return "Catalog";
  if (r.startsWith("inventory/")) return "Inventory";
  if (r.startsWith("locations/") || r.startsWith("zones")) return "Bins & locations";
  if (r.startsWith("integrations/")) return "Lightspeed";
  if (r.startsWith("reports/")) return "Reports";
  return "Other";
}

const VERB: Record<string, string> = { POST: "Changed", PUT: "Saved", PATCH: "Edited", DELETE: "Deleted" };

export function describeRoute(method: string, route: string): { module: ActivityModule; label: string } {
  const e = ROUTES[route];
  if (e) return { module: e.module, label: pick(e, method) };
  const words = route
    .split("/")
    .filter((s) => !s.startsWith("["))
    .slice(-2)
    .join(" ")
    .replace(/-/g, " ");
  return { module: guessModule(route), label: `${VERB[method] ?? method} ${words}` };
}

export function describeAction(action: string): { module: ActivityModule; label: string } {
  const e = ACTIONS[action];
  if (e) return { module: e.module, label: pick(e, "") };
  return { module: "Other", label: action.replace(/_/g, " ") };
}

/** Every route and legacy action that belongs to a module (for filtering). */
export function keysForModule(module: string): { routes: string[]; actions: string[] } {
  return {
    routes: Object.entries(ROUTES).filter(([, e]) => e.module === module).map(([k]) => k),
    actions: Object.entries(ACTIONS).filter(([, e]) => e.module === module).map(([k]) => k),
  };
}

export const SOURCE_LABEL: Record<string, string> = {
  web: "Web",
  web_app: "CarbonWMS-PC app",
  handheld: "Handheld",
  shopify_webhook: "Shopify",
  machine: "System",
  external: "External",
  reader: "Fixed reader",
  job: "Background job",
};

/**
 * Calls that do not leave a lasting change behind — starting/stopping a scan,
 * signing in, tests, AI drafts, previews, lookups, intermediate encode steps,
 * one-off resets. They stay on Reports → Activity history; the dashboard's
 * "Recent activity" shows only real changes to data or settings.
 */
export const NOT_A_CHANGE_ROUTES: readonly string[] = [
  "auth/login",
  "auth/logout",
  "session/location",
  "scan-sessions/start",
  "scan-sessions/stop",
  "scan-sessions/end",
  "dashboard/live-scan/start",
  "dashboard/live-scan/stop",
  "cdm-agents/[id]/live-scan/start",
  "cdm-agents/[id]/live-scan/stop",
  "cdm-agents/[id]/recover",
  "hardware-config/hard-reset",
  "hardware-config/readers/[id]/hard-reset",
  "hardware-config/antennas/[id]/test",
  "antenna-test/start",
  "antenna-test/stop",
  "antenna-test/update",
  "antenna-test/calibrate",
  "antenna-test/calibrate/[id]",
  "rfid/ship-scan-out/reader",
  "generate",
  "openai/item-spec",
  "openai/color-check",
  "openai/image-alt",
  "shopify/seo/audit",
  "shopify/seo/optimize",
  "inventory/size-grading/ai-read",
  "inventory/sync/preview",
  "inventory/bulk-import/scan",
  "compare/runs",
  "rfid/cycle-counts/sessions/[id]/scan",
  "handheld/add-on-sessions/[id]/epc",
  "handheld/add-on-sessions/[id]/epcs",
  "handheld/add-on-sessions/[id]/join-request",
  "rfid/encode-claim",
  "rfid/encode-resolve",
  "rfid/encode-resolve-and-claim",
  "handhelds/epc-queue",
  "devices/[id]/epc-queue",
  "operations/exceptions/simulate",
];

/** Older audit_log actions that are automatic or not lasting changes. */
export const NOT_A_CHANGE_ACTIONS: readonly string[] = [
  "rfid_zone_change",
  "item_live_transition",
  "cdm_agent_auto_mac_bind",
  "cdm_agent_auto_ip_update",
  "cdm_agent_recover_requested",
  "cdm_hard_reset",
  "cdm_reader_hard_reset",
  "cycle_count_scan_start",
  "cycle_count_scan_pause",
  "cycle_count_scan_cancel",
  "lightspeed_catalog_sync",
];
