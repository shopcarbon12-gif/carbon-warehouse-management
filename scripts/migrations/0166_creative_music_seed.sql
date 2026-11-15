-- CarbonWMS Creative — fill the empty Music tab (owner, 2026-11-15) with the 32 starter tracks from the
-- HeyGen music library (public/creative-music). Runs on every deploy: guarded by a marker job so it
-- happens once per tenant; a track already in the library (same name) is skipped by the job itself.
INSERT INTO public.creative_jobs (tenant_id, kind, payload, requested_by, run_after, progress)
SELECT b.tenant_id, 'music_seed', '{"origin":"0166"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '5 minutes', 'Loading the starter music'
  FROM public.creative_brand b
 WHERE NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.tenant_id = b.tenant_id AND j.kind = 'music_seed' AND j.payload->>'origin' = '0166');
