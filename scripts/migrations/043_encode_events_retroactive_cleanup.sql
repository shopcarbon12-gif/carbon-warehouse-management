-- Retroactive cleanup for every successful re-encode the operator did
-- BEFORE encode-finalize was hardened on 2026-05-30 to DELETE (rather
-- than just dismiss) the old EPC's items row.
--
-- Two passes, both idempotent:
--   A. Every encode_events row with status='ok' AND old_epc set:
--      DELETE the matching items row if it's still sitting in
--      'tag_killed' (the state encode-claim left it in). The successful
--      chip write replaced the physical EPC; the items row pointing at
--      the dead old EPC is just visual noise in the Defective EPCs
--      modal + every cycle-count session's DEFECTIVE bucket.
--   B. Every encode_events row with status='ok' AND new_epc set:
--      UPDATE the matching items row from 'unknown' → 'in-stock' if
--      it hadn't already been promoted (handles the case where the
--      pre-2026-05-30 encode-finalize call failed or wasn't sent).
--
-- items has no FK references (verified 2026-05-30) so DELETE is safe.
-- encode_events keeps the old→new mapping for audit.

DO $$
DECLARE
  deleted_old int;
  promoted_new int;
BEGIN
  -- Pass A — delete killed-old-EPC rows that a successful encode left behind.
  WITH targets AS (
    SELECT DISTINCT ee.old_epc AS epc
      FROM encode_events ee
     WHERE ee.status = 'ok'
       AND ee.old_epc IS NOT NULL
       AND ee.old_epc <> ''
  ), del AS (
    DELETE FROM items i
     USING targets t
     WHERE i.epc = t.epc
       AND i.status = 'tag_killed'
    RETURNING 1
  )
  SELECT COUNT(*) INTO deleted_old FROM del;

  -- Pass B — promote new-EPC rows still sitting at 'unknown' because the
  -- finalize step didn't land (network blip, app crash mid-write, etc.).
  WITH targets AS (
    SELECT DISTINCT ee.new_epc AS epc
      FROM encode_events ee
     WHERE ee.status = 'ok'
       AND ee.new_epc IS NOT NULL
       AND ee.new_epc <> ''
  ), upd AS (
    UPDATE items i
       SET status = 'in-stock'
      FROM targets t
     WHERE i.epc = t.epc
       AND i.status = 'unknown'
    RETURNING 1
  )
  SELECT COUNT(*) INTO promoted_new FROM upd;

  RAISE NOTICE 'encode-events retroactive cleanup: deleted % old tag_killed rows; promoted % new unknown rows to in-stock', deleted_old, promoted_new;
END $$;
