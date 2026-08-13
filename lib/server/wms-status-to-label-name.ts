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
  unknown: "UNKNOWN",
  pending_visibility: "PENDING VISIBILITY",
  "in-transit": "IN TRANSIT",
  pending_transaction: "PENDING TRANSACTION",
};

// UNKNOWN was re-introduced in migration 0080 (Shopify sale reconciliation): an
// online sale flips the oldest in-stock tag to `unknown`; a cycle count flips it
// back to `in-stock` if still present. Unmapped statuses fall through to
// TAG KILLED (scanner+UI hidden).
export function labelNameForWmsStatus(wmsStatus: string): string {
  return WMS_STATUS_TO_LABEL_NAME[wmsStatus] ?? "TAG KILLED";
}
