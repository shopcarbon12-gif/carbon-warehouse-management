-- CarbonWMS Creative — film the Sydney Dress UGC again with the natural voice (owner, 2026-11-15: "make her more
-- natural"): Kling 4.0's own voice instead of the robotic clone, human delivery; no subtitles. Same pictures and
-- words. Runs once (marker job origin 0176).
WITH p AS (
  SELECT id, tenant_id FROM public.creative_projects
   WHERE id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0'
     AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0' AND j.payload->>'origin' = '0176')
), c AS (
  UPDATE public.creative_generations g SET status = 'cancelled' FROM p WHERE g.project_id = p.id AND g.kind = 'clip' AND g.status IN ('done', 'rejected') RETURNING g.id
), s AS (
  UPDATE public.creative_projects x SET status = 'approved', edit_plan = COALESCE(x.edit_plan, '{}'::jsonb) - 'takeCaptions', step_note = NULL, updated_at = now() FROM p WHERE x.id = p.id RETURNING x.id
)
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'project_final', '{"upscale4k":false,"origin":"0176"}'::jsonb, 'owner (2026-11-15 chat)', now() + interval '4 minutes', 'Filming it again — natural voice' FROM p;
