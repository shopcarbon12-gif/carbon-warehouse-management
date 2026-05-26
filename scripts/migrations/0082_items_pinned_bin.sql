-- 0082_items_pinned_bin.sql
-- Per-EPC pin to the operator's "store" bin (special-case bin where the
-- pin survives RFID-tracker auto-reassignment + manual moves + other
-- cycle counts). Set by cycle count scans of the matching bin; cleared
-- by a fixed-reader read from a different zone OR by the EPC's status
-- leaving in-stock. See the project memory entry for full semantics.

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS pinned_bin_id uuid NULL;

-- ON DELETE SET NULL so deleting the bin doesn't leak orphan references.
-- A deleted bin clearing every pinned reference matches the operator's
-- mental model: "the bin no longer exists, the pin can't point at
-- anything".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_pinned_bin_id_fkey'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_pinned_bin_id_fkey
      FOREIGN KEY (pinned_bin_id) REFERENCES bins(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Partial index — the catalog SKU list runs an EXISTS check per row to
-- decide whether to render the green pin icon. Indexing only the
-- non-null rows keeps the index small (most items will not be pinned).
CREATE INDEX IF NOT EXISTS items_pinned_bin_id_idx
  ON items (pinned_bin_id)
  WHERE pinned_bin_id IS NOT NULL;

-- Status-change clear: when an item transitions OUT of in-stock (sold,
-- stolen, damaged, tag_killed, etc.) the pin drops with it. Implemented
-- as a BEFORE UPDATE trigger so it's atomic with the status write — no
-- module can sneak a stale pin past a status change. Status transitions
-- WITHIN in-stock or BETWEEN non-in-stock statuses don't touch the pin.
CREATE OR REPLACE FUNCTION items_clear_pin_on_status_leave_in_stock()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'in-stock'
     AND NEW.status IS DISTINCT FROM 'in-stock'
     AND NEW.pinned_bin_id IS NOT NULL
  THEN
    NEW.pinned_bin_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_clear_pin_on_status_leave_in_stock_trg ON items;
CREATE TRIGGER items_clear_pin_on_status_leave_in_stock_trg
  BEFORE UPDATE OF status ON items
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION items_clear_pin_on_status_leave_in_stock();
