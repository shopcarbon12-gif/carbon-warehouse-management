-- CarbonWMS Creative — redo the Sydney Dress UGC shots under the continuity fix (2026-11-15: every shot had an
-- end_state, so most pictures showed the dress on a hanger over different shorts / sweatpants, and the face
-- drifted). Old stills are set aside, the shot list is rewritten for the same concept, new stills follow.
-- Runs on every deploy: once (marker job origin 0168).
WITH p AS (
  SELECT id, tenant_id, concept_idx FROM public.creative_projects
   WHERE id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0' AND concept_idx IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = 'd452441a-c49c-4f7c-9180-c7f357a8ced0' AND j.payload->>'origin' = '0168')
), c AS (
  UPDATE public.creative_generations g SET status = 'cancelled'
    FROM p WHERE g.project_id = p.id AND g.kind IN ('still', 'still_end', 'clip') AND g.status IN ('done', 'rejected')
  RETURNING g.id
), s AS (
  UPDATE public.creative_projects x SET status = 'shots', step_note = NULL, updated_at = now() FROM p WHERE x.id = p.id RETURNING x.id
)
INSERT INTO public.creative_jobs (tenant_id, project_id, kind, payload, requested_by, run_after, progress)
SELECT tenant_id, id, 'project_shots', jsonb_build_object('conceptIdx', concept_idx, 'origin', '0168'), 'owner (2026-11-15 chat)', now() + interval '4 minutes', 'Rewriting the shot list (same outfit and face in every shot)' FROM p;
