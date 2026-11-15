-- CarbonWMS Creative — redraw shot 5 (putting the sneakers on) of the owner's Off Sneakers UGC (2026-11-15): it
-- failed 3 times on a critic that read the sneakers' own stripes as another brand. One half-price batch picture
-- (+ its last frame). Runs once (marker job origin 0174), only while the project is still waiting on Make the video.
WITH p AS (
  SELECT id, tenant_id FROM public.creative_projects
   WHERE id = '92e37b4e-93fc-4c2f-920b-f1a0a31aa5ab' AND status IN ('draft', 'stills')
     AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = '92e37b4e-93fc-4c2f-920b-f1a0a31aa5ab' AND j.payload->>'origin' = '0174')
), s AS (
  UPDATE public.creative_projects x SET status = 'shots', step_note = NULL, updated_at = now() FROM p WHERE x.id = p.id RETURNING x.id
)
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'project_stills', '{"shots":[4],"origin":"0174"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '3 minutes', 'Redrawing shot 5 (putting the sneakers on)' FROM p;
