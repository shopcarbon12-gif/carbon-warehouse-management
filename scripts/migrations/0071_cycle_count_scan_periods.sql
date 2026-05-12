-- Track every Start/Pause cycle on a cycle count so operators (and the
-- exported XLSX) can see when scanning happened and how long it ran.
--
-- scan_periods is an array of `{started_at, ended_at}` objects.
-- ended_at is null while the period is open (status = 'active').
-- On 'active' → 'paused' / 'canceled' / 'committed' transitions, the most
-- recent entry's ended_at gets stamped.
--
-- Backfill: existing sessions have a single approximated period spanning
-- started_at → completed_at (or now for open ones). It is the best we can
-- do without historical state-change records.

ALTER TABLE cycle_count_sessions
  ADD COLUMN IF NOT EXISTS scan_periods JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE cycle_count_sessions
   SET scan_periods = jsonb_build_array(
         jsonb_build_object(
           'started_at', started_at::text,
           'ended_at',   CASE
                           WHEN status IN ('committed', 'canceled')
                           THEN COALESCE(completed_at, started_at)::text
                           ELSE NULL
                         END
         )
       )
 WHERE scan_periods = '[]'::jsonb;
