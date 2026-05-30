-- Rename the "mobile (legacy)" placeholder created by migration 045 to
-- "mobile (pre-tracking)". Operator feedback (2026-05-30): the word
-- "legacy" reads as "old code path that was replaced" rather than
-- "we don't know the exact handheld because the source map didn't
-- exist yet" — confusing when looking at session #020's Source column.
--
-- 045 only stamps "mobile (legacy)" on EPCs the backfill couldn't
-- attribute to a specific reader from cdm_reads. Those rows still
-- ARE the operator's mobile add-on contributions — they just couldn't
-- be split between specific handhelds because per-handheld
-- attribution didn't exist before the source-map deploy.
--
-- Idempotent: a second run finds no source entries with the old name.

UPDATE cycle_count_sessions
   SET scanned_epc_sources = (
     SELECT COALESCE(jsonb_object_agg(
       k,
       CASE
         WHEN v->>'name' = 'mobile (legacy)'
           THEN jsonb_set(v, '{name}', '"mobile (pre-tracking)"')
         ELSE v
       END
     ), '{}'::jsonb)
       FROM jsonb_each(scanned_epc_sources) AS s(k, v)
   )
 WHERE scanned_epc_sources::text LIKE '%mobile (legacy)%';
