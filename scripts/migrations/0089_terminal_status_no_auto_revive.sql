-- 0089_terminal_status_no_auto_revive.sql
--
-- A tag written off as tag_killed / damaged / stolen must never be promoted
-- back to live by a scan. Those three are DECISIONS about the physical tag —
-- it is destroyed, ruined, or gone — and no amount of re-reading it changes
-- that. Only two things may reverse them:
--
--   1. A human, explicitly, via the Status Change / Bulk Status screen.
--   2. Encoding, which retires the old EPC entirely and writes a NEW one live.
--
-- 'unknown' is deliberately NOT in that list. It means "we lost track", and a
-- stray scan recovering it is exactly what it is for (see 0080).
--
-- ## Why this is enforced here and not only in the application
--
-- Every scan module — Count Inventory, Add-On Catalog, Add-On Count, the CDM
-- fixed readers, transfers — converges on an upsert that re-derives status
-- from "does this EPC resolve to a catalog SKU" and writes it unconditionally.
-- Re-reading a killed tag whose EPC still decodes therefore silently promoted
-- it back to in-stock, with no audit row, and it re-entered live inventory as
-- phantom stock.
--
-- 2026-09-02: 64 tags resurrected that way in a single day's counting were
-- restored by hand. Some had been written off months earlier (May, June) and
-- had been quietly flipping back and forth ever since.
--
-- Migration 0084 set the precedent for this shape: rather than hunt every
-- caller that could violate an invariant, enforce it once at the layer they
-- all pass through. Same reasoning, same silent-correction behaviour — the
-- write still succeeds, it just cannot carry an illegal transition.

-- Sanctioned callers set `app.allow_status_revive = 'on'` for the duration of
-- their transaction. Anything that does not set it cannot revive a terminal
-- status, whatever it asks for.
CREATE OR REPLACE FUNCTION items_block_auto_revive()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('tag_killed', 'damaged', 'stolen')
     AND NEW.status = 'in-stock'
     AND COALESCE(current_setting('app.allow_status_revive', true), 'off') <> 'on'
  THEN
    -- Keep the write, drop the illegal transition. Deliberately silent rather
    -- than an exception: a scan pass touching one written-off tag should not
    -- fail the whole upload, and the operator has no useful action to take.
    -- Everything else on the row (last_seen_at, location, bin) still lands, so
    -- the tag's movement history stays accurate while its status holds.
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_block_auto_revive_trg ON public.items;
CREATE TRIGGER items_block_auto_revive_trg
  BEFORE UPDATE OF status ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION items_block_auto_revive();
