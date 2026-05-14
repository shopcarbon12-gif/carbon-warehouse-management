-- Manual (non-RFID) catalog item qty tracking.
--
-- For matrices flagged matrices.is_manual_only = TRUE (added in 0076), the
-- catalog Qty column is no longer derived from EPC counts or LS on-hand +
-- adjustments. Instead, it reads the absolute current_qty stored here, keyed
-- per (custom_sku_id, location_id) — same SKU at two stores keeps two
-- independent counts.
--
-- Every change is OVERRIDE, never additive: each write replaces current_qty
-- with the new authoritative value (LS sync result, cycle count outcome,
-- POS-driven event, transfer slip, manual admin override). Each override
-- also appends one immutable row to manual_item_qty_history with full
-- provenance (source, previous_qty, new_qty, who+when, optional transfer
-- slip + locations + free-form notes + reference to the originating record).
--
-- Sources written initially: lightspeed_sync, manual_override.
-- Future sources (already representable in the schema, just need each
-- caller to be wired): cycle_count, pos_sold, pos_damaged, pos_exchange,
-- pos_return, transfer_out, transfer_in.

CREATE TABLE IF NOT EXISTS manual_item_qty (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_sku_id UUID NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  current_qty INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (custom_sku_id, location_id)
);

CREATE INDEX IF NOT EXISTS manual_item_qty_location_idx
  ON manual_item_qty (location_id);

CREATE TABLE IF NOT EXISTS manual_item_qty_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_sku_id UUID NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  previous_qty INTEGER,
  new_qty INTEGER NOT NULL,
  delta_qty INTEGER,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  /* Snapshot of the user's display name at the time of the change. Survives
     user rename/deletion so old history rows stay attributable. */
  changed_by_user_name TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* Transfer-only context (NULL otherwise). */
  transfer_slip_number TEXT,
  transfer_from_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  transfer_to_location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  /* Free-form notes — e.g. cycle count session id, manual reason. */
  notes TEXT,
  /* Optional UUID of the originating record (sync_jobs.id, cycle_count_sessions.id, transfer_records.id, ...). */
  reference_id UUID
);

CREATE INDEX IF NOT EXISTS manual_item_qty_history_sku_loc_idx
  ON manual_item_qty_history (custom_sku_id, location_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS manual_item_qty_history_changed_at_idx
  ON manual_item_qty_history (changed_at DESC);
