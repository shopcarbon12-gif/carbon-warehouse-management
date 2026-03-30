/** Hover copy for `/settings/statuses` — keyed by `status_labels.name` (Clean 10). */
export const STATUS_LABEL_NAME_TOOLTIPS: Record<string, string> = {
  LIVE: "Standard floor stock. Web/Shopify sellable; handheld shows reads and counts.",
  RETURN: "Not sellable; still visible in search, reporting, and on the scanner.",
  DAMAGED: "Not sellable. Super Admin must approve return to Live.",
  SOLD: "Not sellable. Super Admin must approve return to Live.",
  STOLEN: "Confirmed loss. Handhelds IGNORE this tag — no beep, no count, no session.",
  "TAG KILLED": "Tag destroyed. Scanner and UI hidden; handhelds IGNORE this tag.",
  UNKNOWN: "Unknown disposition. Scanner and UI hidden; handhelds IGNORE this tag.",
  "PENDING VISIBILITY": "System staging only — hidden from staff pickers; handheld ignores reads.",
  "IN TRANSIT": "System workflow — visible but not sellable; staff pickers usually hidden.",
  "PENDING TRANSACTION": "System workflow — visible but not sellable; staff pickers usually hidden.",
};
