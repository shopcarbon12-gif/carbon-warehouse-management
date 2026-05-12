-- 2026-05-12 — Enforce "at most one cdm_reads row per (reader, antenna, epc)".
--
-- Background: cdm_reads was a time-series log — one row per Monsoon read. At
-- the binary's ~5-6 reads/sec/tag burst pattern this filled prod disk to
-- 100% on 2026-05-10 (8.6 GB of 99.98%-redundant rows). The 48-h TTL +
-- write-time formula filter from that incident reduced the bloat but not
-- enough — observed today writing ~10 000 rows/min on a 38 GB disk.
--
-- Operator decision 2026-05-12: each (reader, antenna, epc) gets exactly
-- one row, with read_at + rssi reflecting the MOST RECENT observation.
-- Downstream queries already filter on `read_at > now() - interval N`, so
-- "last seen in last 15 min" works against the latest-observation row.
--
-- Steps:
--  1. Dedupe existing rows in place: keep only the row with the max read_at
--     per (reader_id, antenna_id, epc_hex). Uses COALESCE for antenna_id so
--     NULL antennas dedup the same way the new constraint will.
--  2. Add a UNIQUE INDEX with NULLS NOT DISTINCT (Postgres 15+) so antenna_id
--     IS NULL rows still dedup. Wrapped in a guard so re-running is a no-op.
--  3. INSERT path in lib/server/cdm-agents.ts is updated separately to use
--     `ON CONFLICT ... DO UPDATE SET read_at = EXCLUDED.read_at, rssi = ...`.

DO $$
BEGIN
  IF to_regclass('public.cdm_reads') IS NULL THEN
    RETURN;
  END IF;

  -- 1. TRUNCATE to wipe redundant historical rows fast. cdm_reads is a
  --    48-h ephemeral log by design (see pruneOldCdmReads); operators
  --    don't rely on rows older than ~24 h. Doing a batched in-place
  --    dedup of 3M+ rows would lock the table for tens of seconds
  --    during deploy with the new container live-writing. TRUNCATE
  --    is one atomic instant.
  --
  --    Guard with the index check so re-running the migration on a
  --    table that's already constrained doesn't wipe live data.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'cdm_reads_reader_antenna_epc_unique'
  ) THEN
    TRUNCATE TABLE cdm_reads;
    EXECUTE 'CREATE UNIQUE INDEX cdm_reads_reader_antenna_epc_unique
             ON cdm_reads (reader_id, antenna_id, epc_hex) NULLS NOT DISTINCT';
  END IF;
END $$;
