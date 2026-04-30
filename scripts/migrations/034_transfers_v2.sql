-- Transfers v2: explicit transfer record, in-transit lifecycle, manual (non-RFID)
-- adjustments. Replaces the legacy "audit_log → rfid_transfer" one-shot flow.
--
-- Lifecycle:
--   1. Operator commits Transfer Out:
--      * RFID items flip to status='in-transit', location_id=destination, bin_id=NULL,
--        transfer_id=<new>.
--      * Manual lines emit two inventory_adjustments rows per (custom_sku, qty):
--          source side  → state='settled', delta=-qty   (catalog drops immediately)
--          dest side    → state='in-transit', delta=+qty (catalog ignores until received)
--   2. Operator commits Transfer In (Receive):
--      * RFID items flip back to status='in-stock', bin_id=auto-routed (most-used bin
--        for this custom_sku at destination, or NULL if none).
--      * Manual dest-side adjustments flip to state='settled'.
--      * transfer_records.state transitions to 'received' (or 'partially_received').

-- 1. Items: relax bin_id (it's already nullable in 0041) + add transfer_id link.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS transfer_id UUID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_transfer_id_idx
  ON items (transfer_id) WHERE transfer_id IS NOT NULL;
--> statement-breakpoint

-- 2. transfer_records: one row per transfer batch (out commit creates, receive settles).
CREATE TABLE IF NOT EXISTS transfer_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source_location_id       UUID NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  destination_location_id  UUID NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  state                    VARCHAR(32) NOT NULL DEFAULT 'in-transit',
  rfid_count               INTEGER NOT NULL DEFAULT 0,
  manual_count             INTEGER NOT NULL DEFAULT 0,
  created_by               UUID,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by              UUID,
  received_at              TIMESTAMPTZ,
  notes                    TEXT,
  CONSTRAINT transfer_records_state_check CHECK (
    state IN ('in-transit', 'received', 'partially_received', 'cancelled')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfer_records_dest_pending_idx
  ON transfer_records (destination_location_id, created_at DESC)
  WHERE state IN ('in-transit', 'partially_received');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfer_records_tenant_created_idx
  ON transfer_records (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfer_records_source_idx
  ON transfer_records (source_location_id, created_at DESC);
--> statement-breakpoint

-- Wire items.transfer_id → transfer_records.id (FK after table exists).
ALTER TABLE items
  DROP CONSTRAINT IF EXISTS items_transfer_id_fkey;
--> statement-breakpoint
ALTER TABLE items
  ADD CONSTRAINT items_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES transfer_records (id) ON DELETE SET NULL;
--> statement-breakpoint

-- 3. inventory_adjustments: tracks non-RFID (manual) units moving through transfers.
-- Each manual line on a transfer produces TWO rows:
--   * (location_id=source, side='source', state='settled', delta=-qty)        ← drops source qty immediately
--   * (location_id=dest,   side='destination', state='in-transit', delta=+qty) ← appears at dest only after receive
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  custom_sku_id   UUID NOT NULL REFERENCES custom_skus (id) ON DELETE RESTRICT,
  location_id     UUID NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
  transfer_id     UUID REFERENCES transfer_records (id) ON DELETE SET NULL,
  side            VARCHAR(16) NOT NULL,
  state           VARCHAR(16) NOT NULL DEFAULT 'in-transit',
  qty_delta       INTEGER NOT NULL,
  reason          VARCHAR(64) NOT NULL DEFAULT 'manual_transfer',
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CONSTRAINT inventory_adjustments_side_check CHECK (side IN ('source', 'destination')),
  CONSTRAINT inventory_adjustments_state_check CHECK (state IN ('in-transit', 'settled', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_adjustments_sku_loc_state_idx
  ON inventory_adjustments (custom_sku_id, location_id, state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_adjustments_transfer_idx
  ON inventory_adjustments (transfer_id) WHERE transfer_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_adjustments_tenant_created_idx
  ON inventory_adjustments (tenant_id, created_at DESC);
--> statement-breakpoint

-- 4. status_labels: 'in-transit' (system_id=9, IN TRANSIT) already exists in seed.
-- See /settings/statuses for the hard-wired rule. The DO-block makes this safe
-- whether the row collides on `name`, on `legacy_id`, on neither, or — most
-- importantly — when both UNIQUE columns conflict on different existing rows
-- (which a plain `ON CONFLICT (name)` could not handle and was halting the
-- whole migration chain on prod, blocking 035 from running).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM status_labels WHERE name = 'in-transit')
     AND NOT EXISTS (SELECT 1 FROM status_labels WHERE legacy_id = 9) THEN
    INSERT INTO status_labels (legacy_id, name, include_in_inventory)
    VALUES (9, 'in-transit', false);
  END IF;
END
$$;
