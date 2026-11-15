-- CarbonWMS Creative — the Sydney Dress UGC gets a natural script (owner, 2026-11-15: "she shouldn't talk like a
-- walking advertisement… like a woman filming herself in front of the mirror"). Same pictures; the old take is set
-- aside by the job; the owner taps Make the video. Runs once (marker job origin 0171).
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'ugc_rescript', '{"origin":"0171"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '3 minutes', 'Rewriting what she says'
  FROM public.creative_projects
 WHERE id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0'
   AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0' AND j.payload->>'origin' = '0171');
