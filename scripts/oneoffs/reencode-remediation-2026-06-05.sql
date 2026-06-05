-- Re-encode data remediation — 2026-06-05
-- Cleans up the corruption caused by the pre-fix flow that flipped the OLD EPC
-- to 'tag_killed' at CLAIM time (before the chip write was confirmed) and relied
-- on fire-and-forget finalize/rollback.
--
-- DO NOT run blind. Each block is wrapped in its own transaction. Review the
-- SELECT counts first. These mutate live inventory and are not reversible.

-- ── Bucket 1: SUCCESSFUL re-encodes whose old row was never deleted ───────────
-- Old EPC is 'tag_killed' AND a replacement new EPC is currently 'in-stock'.
-- The re-encode genuinely succeeded; finalize just never completed the delete.
-- Action: hard-delete the obsolete old rows. (~197)
BEGIN;
  WITH killed AS (
    SELECT i.id, i.epc AS old_epc
    FROM items i
    WHERE i.status = 'tag_killed'
      AND i.epc IN (SELECT old_epc FROM encode_events)
  ),
  to_delete AS (
    SELECT k.id FROM killed k
    WHERE EXISTS (
      SELECT 1 FROM encode_events e
      JOIN items ni ON ni.epc = e.new_epc AND ni.status = 'in-stock'
      WHERE e.old_epc = k.old_epc
    )
  )
  DELETE FROM items WHERE id IN (SELECT id FROM to_delete);
COMMIT;

-- ── Bucket 2: FAILED re-encodes that wrongly removed a still-live item ────────
-- Old EPC is 'tag_killed' AND NO replacement new EPC is in-stock. The chip write
-- failed; the physical chip still broadcasts the OLD EPC and is live — but the
-- WMS row was removed. Action: restore to 'in-stock'. (~128)
-- CAVEAT: a small number of these may be false-fails where the chip actually
-- took the new EPC; the only fully-correct reconciliation is a physical re-scan
-- (cycle count) which ingest will reconcile. Restoring is the safe default —
-- it returns the lost inventory; a later count corrects any false-fail.
BEGIN;
  WITH killed AS (
    SELECT i.id, i.epc AS old_epc
    FROM items i
    WHERE i.status = 'tag_killed'
      AND i.epc IN (SELECT old_epc FROM encode_events)
  ),
  to_restore AS (
    SELECT k.id FROM killed k
    WHERE NOT EXISTS (
      SELECT 1 FROM encode_events e
      JOIN items ni ON ni.epc = e.new_epc AND ni.status = 'in-stock'
      WHERE e.old_epc = k.old_epc
    )
  )
  UPDATE items SET status = 'in-stock' WHERE id IN (SELECT id FROM to_restore);
COMMIT;

-- ── Bucket 3: orphaned new EPCs claimed but never confirmed ───────────────────
-- New EPC stuck at 'unknown' from a claim whose device never finalized/rolled
-- back. Not counted in inventory. Action: delete the phantom rows. (~11)
-- These are unconfirmed: if any chip actually took the write it will surface on
-- the next cycle count as an unknown EPC and ingest will re-add it.
BEGIN;
  DELETE FROM items
  WHERE status = 'unknown'
    AND epc IN (SELECT new_epc FROM encode_events);
COMMIT;
