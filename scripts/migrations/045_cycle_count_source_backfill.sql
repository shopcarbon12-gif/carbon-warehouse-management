-- Retroactively populate cycle_count_sessions.scanned_epc_sources from
-- the data we DO have available historically: cdm_reads (reader-attributed
-- scans) and the session timeline. Every EPC in `scanned_epcs` that's
-- NOT already in the source map gets a best-effort entry:
--
--   1. If a cdm_reads row exists for the same tenant + matching reader
--      at the session's location, between the session's started_at and
--      its completed_at (or now() if active), we tag the EPC as
--      `kind=reader` with `name=devices.name` and `ts=<earliest read_at>`.
--   2. Everything else falls back to `kind=mobile, name='mobile (pre-tracking)',
--      ts=session.started_at`. We can't reconstruct which specific
--      handheld contributed each EPC pre-migration — that's why this
--      bucket exists.
--
-- Idempotent: only fills slots that are missing. Running again is a no-op.

DO $$
DECLARE
  s RECORD;
  total_sessions int := 0;
  total_filled int := 0;
BEGIN
  FOR s IN
    SELECT id, location_id, started_at, COALESCE(completed_at, now()) AS ended_at,
           scanned_epcs, scanned_epc_sources
      FROM cycle_count_sessions
     WHERE jsonb_array_length(scanned_epcs) > 0
  LOOP
    total_sessions := total_sessions + 1;

    -- Find every EPC that doesn't have an entry in the source map yet.
    WITH session_epcs AS (
      SELECT upper(epc::text) AS epc
        FROM jsonb_array_elements_text(s.scanned_epcs) AS epc
    ),
    missing AS (
      SELECT e.epc
        FROM session_epcs e
       WHERE NOT (s.scanned_epc_sources ? e.epc)
    ),
    -- Try to attribute each missing EPC to its earliest matching cdm_reads
    -- row at this session's location, inside the session window. DISTINCT ON
    -- (epc) keeps the earliest sighting.
    reader_hits AS (
      SELECT DISTINCT ON (upper(cr.epc_hex))
             upper(cr.epc_hex) AS epc,
             COALESCE(d.name, 'reader') AS reader_name,
             cr.read_at
        FROM cdm_reads cr
        JOIN devices d ON d.id = cr.reader_id
       WHERE d.location_id = s.location_id
         AND cr.read_at >= s.started_at
         AND cr.read_at <= s.ended_at
         AND upper(cr.epc_hex) IN (SELECT epc FROM missing)
       ORDER BY upper(cr.epc_hex), cr.read_at ASC
    ),
    -- Build the merged source map: existing entries are preserved,
    -- missing EPCs get either a reader hit OR the mobile (pre-tracking) fallback.
    new_sources AS (
      SELECT jsonb_object_agg(
        epc,
        jsonb_build_object(
          'kind', kind,
          'name', name,
          'ts',   ts
        )
      ) AS map
      FROM (
        SELECT m.epc,
               COALESCE(rh.epc IS NOT NULL,  false) AS has_reader,
               CASE WHEN rh.epc IS NOT NULL THEN 'reader' ELSE 'mobile' END AS kind,
               CASE WHEN rh.epc IS NOT NULL THEN rh.reader_name
                    ELSE 'mobile (pre-tracking)' END AS name,
               CASE WHEN rh.epc IS NOT NULL
                    THEN to_char(rh.read_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    ELSE to_char(s.started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               END AS ts
          FROM missing m
          LEFT JOIN reader_hits rh ON rh.epc = m.epc
      ) x
    )
    UPDATE cycle_count_sessions
       SET scanned_epc_sources =
             COALESCE(scanned_epc_sources, '{}'::jsonb)
             || COALESCE((SELECT map FROM new_sources), '{}'::jsonb)
     WHERE id = s.id;

    GET DIAGNOSTICS total_filled = ROW_COUNT;
  END LOOP;

  RAISE NOTICE 'cycle-count source backfill: scanned % session(s)', total_sessions;
END $$;
