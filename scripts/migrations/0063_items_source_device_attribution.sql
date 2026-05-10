-- 2026-05-10 — track WHICH device read/wrote each item, not just the
-- generic source label.
--
-- Existing fields:
--   items.source              — string enum (fixed_reader, handheld, transfer, …)
--   items.source_device_label — free-form display string (android_id, "cycle:LOC/BIN", …)
--
-- Limitations: source_device_label is text, not joinable. "Which RFD-8500
-- encoded this tag?" required string-matching against android_id, and any
-- rename of the device on the Hardware Config page broke historical lookups.
--
-- New columns:
--   items.source_device_id    — devices.id of the reader / handheld / printer
--                               that originated the item (handheld_reader for
--                               operator scans + RFD-8500 encodes; fixed_reader
--                               for any future fixed-reader-driven commission;
--                               printer for future ZD500R commission attribution)
--   items.source_antenna_id   — devices.id where device_type='antenna'.
--                               Only set when the originating device is a
--                               fixed_reader and we can attribute to a specific
--                               antenna. NULL for handhelds (single-radio).
--
-- Both nullable. NULL semantics: "device unknown / not applicable" — covers
-- the bulk-import script, the operations-transfers staging-fill path (no
-- specific device involved), and historical rows from before this migration.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS source_device_id UUID
    REFERENCES devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_antenna_id UUID
    REFERENCES devices(id) ON DELETE SET NULL;

-- Per-device "what did this scanner produce" lookups + audit windows.
CREATE INDEX IF NOT EXISTS items_source_device_id_created_at_idx
  ON items (source_device_id, created_at DESC)
  WHERE source_device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS items_source_antenna_id_created_at_idx
  ON items (source_antenna_id, created_at DESC)
  WHERE source_antenna_id IS NOT NULL;
