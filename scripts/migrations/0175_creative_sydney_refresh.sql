-- CarbonWMS Creative — the Sydney Dress UGC: natural post captions (the old slogans were still there) and a free
-- re-cut with subtitles from her real voice. Runs once (marker job origin 0175).
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'ugc_refresh', '{"origin":"0175"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '3 minutes', 'Writing natural post captions'
  FROM public.creative_projects
 WHERE id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0'
   AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0' AND j.payload->>'origin' = '0175');
