import type { Pool, PoolClient } from "pg";

/**
 * Override semantics for manual (non-RFID) catalog item quantities.
 *
 * Every manual item event (LS sync, cycle count, POS sale, transfer, admin
 * correction) calls this helper. It REPLACES the current_qty for the given
 * (custom_sku_id, location_id) and appends one row to manual_item_qty_history
 * with full provenance.
 *
 * Designed to be called inside an existing transaction OR via the pool
 * directly. The optional `client` parameter lets callers participate in
 * a larger transaction (e.g. cycle count Finish, LS sync).
 */

export type ManualItemQtySource =
  | "lightspeed_sync"
  | "cycle_count"
  | "manual_override"
  | "pos_sold"
  | "pos_damaged"
  | "pos_exchange"
  | "pos_return"
  | "transfer_out"
  | "transfer_in";

export type ApplyManualOverrideArgs = {
  customSkuId: string;
  locationId: string;
  newQty: number;
  source: ManualItemQtySource;
  changedByUserId: string | null;
  changedByUserName: string | null;
  notes?: string | null;
  referenceId?: string | null;
  transferSlipNumber?: string | null;
  transferFromLocationId?: string | null;
  transferToLocationId?: string | null;
};

export type ApplyManualOverrideResult = {
  previousQty: number | null;
  newQty: number;
  deltaQty: number | null;
  historyId: string;
};

/**
 * Apply a single manual-item override + history row. Idempotent at the
 * (sku, location) level: repeated calls keep replacing current_qty and
 * appending history, never doubling up.
 */
export async function applyManualItemOverride(
  exec: Pool | PoolClient,
  args: ApplyManualOverrideArgs,
): Promise<ApplyManualOverrideResult> {
  const newQty = Math.max(0, Math.trunc(args.newQty));

  const prev = await exec.query<{ current_qty: number }>(
    `SELECT current_qty FROM manual_item_qty
      WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid`,
    [args.customSkuId, args.locationId],
  );
  const previousQty = prev.rowCount && prev.rows[0]
    ? Number(prev.rows[0].current_qty)
    : null;
  const deltaQty = previousQty == null ? null : newQty - previousQty;

  await exec.query(
    `INSERT INTO manual_item_qty (custom_sku_id, location_id, current_qty, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::int, now())
     ON CONFLICT (custom_sku_id, location_id) DO UPDATE
       SET current_qty = EXCLUDED.current_qty,
           updated_at = now()`,
    [args.customSkuId, args.locationId, newQty],
  );

  const ins = await exec.query<{ id: string }>(
    `INSERT INTO manual_item_qty_history (
       custom_sku_id, location_id, source,
       previous_qty, new_qty, delta_qty,
       changed_by_user_id, changed_by_user_name,
       notes, reference_id,
       transfer_slip_number, transfer_from_location_id, transfer_to_location_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::text,
       $4::int, $5::int, $6::int,
       $7::uuid, $8::text,
       $9::text, $10::uuid,
       $11::text, $12::uuid, $13::uuid
     )
     RETURNING id::text`,
    [
      args.customSkuId,
      args.locationId,
      args.source,
      previousQty,
      newQty,
      deltaQty,
      args.changedByUserId,
      args.changedByUserName,
      args.notes ?? null,
      args.referenceId ?? null,
      args.transferSlipNumber ?? null,
      args.transferFromLocationId ?? null,
      args.transferToLocationId ?? null,
    ],
  );

  return {
    previousQty,
    newQty,
    deltaQty,
    historyId: ins.rows[0]!.id,
  };
}

/**
 * Resolve a user's display name (currently their email) for use as the
 * snapshot in manual_item_qty_history.changed_by_user_name. NULL-safe.
 */
export async function lookupUserNameForHistory(
  exec: Pool | PoolClient,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const r = await exec.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1::uuid`,
    [userId],
  );
  return r.rows[0]?.email ?? null;
}
