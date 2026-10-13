/**
 * Status that holds an online order's tags between payment and shipping.
 *
 * The orders/paid webhook (and the exchange "new items" path) moves the oldest
 * LIVE tags of each ordered SKU to this status, so WMS live qty drops the
 * moment Shopify sells the unit. Shipping (scan-out → sold), fulfillment,
 * refunds and return restocks release it again.
 *
 * Owner decision 2026-10-13: holds use 'pending_transaction' instead of
 * 'unknown'. Scans may revive 'unknown' ("lost track, handheld can recover"),
 * so a cycle count had flipped order #1080's held tags back to LIVE. Pending
 * Transaction is ghosted on the Statuses page and no scan can change it.
 *
 * Holds placed before that change are still 'unknown'; every flow that looks
 * for a hold must accept both — use ORDER_HOLD_STATUSES.
 */
export const ORDER_HOLD_STATUS = "pending_transaction";

/** Current hold status first, then the legacy one. */
export const ORDER_HOLD_STATUSES: readonly string[] = [ORDER_HOLD_STATUS, "unknown"];
