/**
 * Maps `items.status` (WMS constraint) to `status_labels.name` for flag lookup.
 * Extend when new item statuses are introduced.
 */
export const WMS_STATUS_TO_LABEL_NAME: Record<string, string> = {
  "in-stock": "Live",
  sold: "Sold",
  "in-transit": "In Transit",
  missing: "Unknown",
  damaged: "Damaged",
  INCOMPLETE: "Unknown",
  UNKNOWN: "Unknown",
  COMMISSIONED: "Unknown",
};

export function labelNameForWmsStatus(wmsStatus: string): string {
  return WMS_STATUS_TO_LABEL_NAME[wmsStatus] ?? "Unknown";
}
