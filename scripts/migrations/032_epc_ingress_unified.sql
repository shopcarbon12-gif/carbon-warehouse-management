-- v3.3: Unified EPC ingress.
-- Every EPC entering the WMS — fixed reader, handheld, transfer, manual,
-- cycle count — runs through the same decode + match path:
--   1. Decode using the tenant's EPC formula (prefix bits, asset bits, serial bits).
--   2. Look up `ls_system_id` against the catalog. Match → status = LIVE.
--   3. No match (or undecodable) → status = TAG KILLED. Hidden from catalog,
--      transfers, scanners — surfaced only in the new Defective EPCs dialog.
--
-- This migration:
--   A. Adds `tenant_epc_config` (one row per tenant) holding the formula.
--   B. Adds `items.source`, `items.source_device_label`, `items.first_scanned_at`.
--   C. Relaxes `items.custom_sku_id` to NULLable (Tag Killed items have no SKU).
--   D. Wipes existing items + AUTO-PENDING placeholder. Keeps one test EPC
--      (F0A0B30E12345678ABCDEF99) seeded as Tag Killed for end-to-end testing.

--> statement-breakpoint
-- A. tenant_epc_config: per-tenant EPC layout.
--    Mirrors Senitron's "General Settings" page (prefix, asset bits, serial
--    bits, padding, last encoded serial). Tenant-scoped so a future second
--    tenant could ship with different bit allocations or a different prefix
--    without a code change.
CREATE TABLE IF NOT EXISTS tenant_epc_config (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  prefix_hex           TEXT   NOT NULL,
  prefix_bits          INT    NOT NULL DEFAULT 20,
  asset_bits           INT    NOT NULL DEFAULT 40,
  serial_bits          INT    NOT NULL DEFAULT 36,
  asset_padding_digits INT    NOT NULL DEFAULT 12,
  last_encoded_serial  BIGINT NOT NULL DEFAULT 100000,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_epc_config_bits_total
    CHECK (prefix_bits + asset_bits + serial_bits = 96),
  CONSTRAINT tenant_epc_config_prefix_hex_format
    CHECK (prefix_hex ~ '^[0-9A-Fa-f]+$')
);

--> statement-breakpoint
-- Seed: every existing tenant gets the Carbon Jeans defaults
-- (F0A0B / 20 / 40 / 36 / padding=12 / starting serial=100000).
-- Idempotent — re-running the migration won't overwrite a tenant that
-- has already customized their values.
INSERT INTO tenant_epc_config (
  tenant_id, prefix_hex, prefix_bits, asset_bits, serial_bits,
  asset_padding_digits, last_encoded_serial
)
SELECT id, 'F0A0B', 20, 40, 36, 12, 100000
FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

--> statement-breakpoint
-- B. items: provenance columns. `source` is a free-form text on purpose
-- (no enum) so future ingress modules can use new labels without a
-- schema migration. Application code keeps the canonical set in TS.
--
-- `defective_acknowledged_at` is set when a user clicks "Dismiss" in the
-- Defective EPCs modal. The popup query filters out dismissed rows BUT
-- brings them back when last_seen_at moves past defective_acknowledged_at
-- (i.e. the same defective EPC was scanned again and is still defective).
-- It never affects items.status; only the user can change a tag's status.
ALTER TABLE items ADD COLUMN IF NOT EXISTS source                    TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS source_device_label       TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS first_scanned_at          TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS defective_acknowledged_at TIMESTAMPTZ;

--> statement-breakpoint
-- C. Relax custom_sku_id so Tag Killed items can sit unattached.
-- Was: NOT NULL REFERENCES custom_skus ON DELETE RESTRICT
-- Now: NULLable + ON DELETE SET NULL (deleting a SKU no longer blocks).
ALTER TABLE items ALTER COLUMN custom_sku_id DROP NOT NULL;

--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_custom_sku_id_fkey;
EXCEPTION WHEN undefined_object THEN
  -- some installs may have a different generated FK name; ignore
  NULL;
END $$;

--> statement-breakpoint
ALTER TABLE items
  ADD CONSTRAINT items_custom_sku_id_fkey
  FOREIGN KEY (custom_sku_id) REFERENCES custom_skus (id)
  ON DELETE SET NULL ON UPDATE CASCADE;

--> statement-breakpoint
-- Indexes for the new ingress + Defective EPCs view.
CREATE INDEX IF NOT EXISTS items_first_scanned_at_idx ON items (first_scanned_at DESC);
CREATE INDEX IF NOT EXISTS items_source_idx           ON items (source);
CREATE INDEX IF NOT EXISTS items_status_first_scanned_idx ON items (status, first_scanned_at DESC);
-- Partial index for the Defective EPCs popup — only tag_killed rows,
-- which is the tiny subset the modal ever queries.
CREATE INDEX IF NOT EXISTS items_defective_view_idx
  ON items (first_scanned_at DESC)
  WHERE status = 'tag_killed';

--> statement-breakpoint
-- D.1 Wipe: remove every items row except the test fixture EPC.
-- Operator asked for a clean slate — production rebuild starts here.
DELETE FROM items WHERE epc != 'F0A0B30E12345678ABCDEF99';

--> statement-breakpoint
-- D.2 Test fixture: ensure F0A0B30E12345678ABCDEF99 exists as a Tag Killed
-- item, with the correctly decoded 36-bit serial. We pick *any* existing
-- location for the test EPC (Tag Killed items still need a location_id —
-- the location captures where the EPC was first seen). Decoded values:
--   prefix:  F0A0B  (matches tenant config)
--   item#:   209935615335  (no matching ls_system_id → Tag Killed)
--   serial:  37242138521  (last 36 bits of the EPC)
DO $$
DECLARE
  v_loc UUID;
BEGIN
  SELECT id INTO v_loc FROM locations LIMIT 1;
  IF v_loc IS NULL THEN
    RAISE NOTICE 'wms: no locations exist; skipping test EPC seed';
    RETURN;
  END IF;
  INSERT INTO items (
    epc, serial_number, custom_sku_id, location_id,
    status, last_seen_at, first_scanned_at,
    source, source_device_label
  ) VALUES (
    'F0A0B30E12345678ABCDEF99',
    37242138521,        -- decoded 36-bit serial
    NULL,               -- no matching catalog SKU → Tag Killed
    v_loc,
    'tag_killed',
    now(),
    now(),
    'manual',
    'test fixture'
  )
  ON CONFLICT (epc) DO UPDATE SET
    serial_number       = EXCLUDED.serial_number,
    custom_sku_id       = NULL,
    status              = 'tag_killed',
    last_seen_at        = now(),
    first_scanned_at    = COALESCE(items.first_scanned_at, EXCLUDED.first_scanned_at),
    source              = COALESCE(items.source, EXCLUDED.source),
    source_device_label = COALESCE(items.source_device_label, EXCLUDED.source_device_label);
END $$;

--> statement-breakpoint
-- D.3 Drop the AUTO-PENDING placeholder + matrix entirely.
-- The new ingress path doesn't use them — Tag Killed items have NULL
-- custom_sku_id instead of pointing at a placeholder.
DELETE FROM custom_skus WHERE sku = 'AUTO-PENDING';

--> statement-breakpoint
DELETE FROM matrices WHERE description = 'Auto-commissioned (Pending)';
