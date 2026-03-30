/** Clean 10 — `items.status` values exposed for bulk update UI + API allow-list. */
export type BulkWmsStatusOption = {
  value: string;
  label: string;
  /** Hidden from non–Super Admin dropdowns (staff). */
  systemOnly: boolean;
};

export const BULK_WMS_STATUS_OPTIONS: BulkWmsStatusOption[] = [
  { value: "in-stock", label: "Live (sellable)", systemOnly: false },
  { value: "return", label: "Return (not sellable)", systemOnly: false },
  { value: "damaged", label: "Damaged", systemOnly: false },
  { value: "sold", label: "Sold", systemOnly: false },
  { value: "stolen", label: "Stolen", systemOnly: false },
  { value: "tag_killed", label: "Tag killed", systemOnly: false },
  { value: "UNKNOWN", label: "Unknown", systemOnly: false },
  { value: "pending_visibility", label: "Pending visibility (system)", systemOnly: true },
  { value: "in-transit", label: "In transit (system)", systemOnly: true },
  { value: "pending_transaction", label: "Pending transaction (system)", systemOnly: true },
];

export function bulkStatusOptionsForUi(superAdmin: boolean): BulkWmsStatusOption[] {
  if (superAdmin) return BULK_WMS_STATUS_OPTIONS;
  return BULK_WMS_STATUS_OPTIONS.filter((o) => !o.systemOnly);
}
