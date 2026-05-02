/**
 * Maps `items.status` (WMS CHECK constraint) to `status_labels.name` (Clean 10 brain).
 */
export const WMS_STATUS_TO_LABEL_NAME: Record<string, string> = {
  "in-stock": "LIVE",
  return: "RETURN",
  damaged: "DAMAGED",
  sold: "SOLD",
  stolen: "STOLEN",
  tag_killed: "TAG KILLED",
  pending_visibility: "PENDING VISIBILITY",
  "in-transit": "IN TRANSIT",
  pending_transaction: "PENDING TRANSACTION",
};

// UNKNOWN was retired in migration 0043 — anything that previously fell
// through to UNKNOWN now maps to TAG KILLED, which is the functionally
// identical "scanner+UI hidden, handhelds ignore" status.
export function labelNameForWmsStatus(wmsStatus: string): string {
  return WMS_STATUS_TO_LABEL_NAME[wmsStatus] ?? "TAG KILLED";
}
