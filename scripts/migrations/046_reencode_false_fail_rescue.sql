-- Rescue the 6 EPCs from the operator's 2026-05-29 re-encode session that
-- the mobile app reported WRITE_FAILED but the chip ACTUALLY wrote (geiger-
-- verified by the operator on 2026-05-30 — the chips broadcast the new
-- EPC and the old EPC is silent).
--
-- Root cause: the Chainway controller's verifyEpcWrite loop hit 0 new-EPC
-- sightings within the 1500ms post-power-cycle window. The chip had
-- written, but for one of these reasons it wasn't sighted in time:
--   (a) tag at the edge of read range when the operator naturally moved
--       the gun after the write completed,
--   (b) tag still in its post-power-cycle re-boot when verify began
--       polling (Chainway chips sometimes need >300ms to come back),
--   (c) buffer drain consumed the few new-EPC reads we did get.
-- The Zebra controller already had a "is the old EPC actually gone"
-- fallback that promotes verify-false to true; Chainway didn't. A
-- companion mobile-side fix (CarbonChainwayRfidController.kt — same
-- commit) adds the equivalent fallback by checking the read-back EPC
-- against newEpc. From the next APK on, this class of false-fail
-- self-rescues at the radio layer and no manual cleanup is required.
--
-- Per-pair work for this batch:
--   1. Promote the NEW EPC items row from 'unknown' → 'in-stock' so
--      the catalog counts it as LIVE.
--   2. DELETE the OLD EPC items row (it was left at 'tag_killed' by
--      encode-claim and never cleaned up because no encode-finalize
--      ran for these chips).
--
-- Idempotent: re-running finds no matching rows.

DO $$
DECLARE
  pair RECORD;
  promoted int := 0;
  deleted  int := 0;
  upd_ct   int;
  del_ct   int;
BEGIN
  -- (old_epc, new_epc) pairs verified by the operator via geiger 2026-05-30.
  FOR pair IN
    SELECT *
      FROM (VALUES
        ('C11121243110411015776156', 'F0A0B30E4F9BCC90000186A1'),
        ('C12591608E63717506421271', 'F0A0B30E4F9C155021563263'),
        ('C21631629074212505217991', 'F0A0B30E4F9C1DB0000186A1'),
        ('C12601609073918000909769', 'F0A0B30E4F9C1650000186A1'),
        ('C12591605623712720634193', 'F0A0B30E4F9C1750000186A1'),
        ('C21631625114016184968146', 'F0A0B30E4F9C1A20000186A1')
      ) AS p(old_epc, new_epc)
  LOOP
    -- Promote new EPC to LIVE if still sitting at 'unknown'.
    UPDATE items
       SET status = 'in-stock'
     WHERE epc = upper(pair.new_epc)
       AND status = 'unknown';
    GET DIAGNOSTICS upd_ct = ROW_COUNT;
    promoted := promoted + upd_ct;

    -- Delete the orphaned tag_killed old EPC.
    DELETE FROM items
     WHERE epc = upper(pair.old_epc)
       AND status = 'tag_killed';
    GET DIAGNOSTICS del_ct = ROW_COUNT;
    deleted := deleted + del_ct;
  END LOOP;

  RAISE NOTICE 'reencode false-fail rescue: promoted % new EPC(s) to in-stock; deleted % old tag_killed EPC(s)', promoted, deleted;
END $$;
