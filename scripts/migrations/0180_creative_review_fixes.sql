-- CarbonWMS Creative review (2026-11-15):
-- 1. The headline font's NAME was the file name ("Neuzeit_Grotesk_W01_Regular"); the upload now derives a clean
--    family name — the one already stored is cleaned the same way.
UPDATE public.creative_brand
   SET fonts = jsonb_set(fonts, '{headline}', to_jsonb('Neuzeit Grotesk'::text)), updated_at = now()
 WHERE fonts->>'headline' = 'Neuzeit_Grotesk_W01_Regular';
-- 2. Radar's official Meta API source failed on every run (no permission; EU ads only): an explicit "on" saved
--    in settings is turned off so it stops filling the job list with failures.
UPDATE public.creative_settings
   SET sources = jsonb_set(sources, '{meta_api}', COALESCE(sources->'meta_api', '{}'::jsonb) || '{"enabled": false}'::jsonb)
 WHERE sources ? 'meta_api' AND (sources->'meta_api'->>'enabled')::boolean IS TRUE;
