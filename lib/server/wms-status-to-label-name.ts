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
  UNKNOWN: "UNKNOWN",
  pending_visibility: "PENDING VISIBILITY",
  "in-transit": "IN TRANSIT",
  pending_transaction: "PENDING TRANSACTION",
};

export function labelNameForWmsStatus(wmsStatus: string): string {
  return WMS_STATUS_TO_LABEL_NAME[wmsStatus] ?? "UNKNOWN";
}
