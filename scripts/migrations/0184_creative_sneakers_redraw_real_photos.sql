-- CarbonWMS Creative — owner, 2026-11-15 ("do it all"): the Off Sneakers project ("Swap On Concrete") is drawn again
-- from scratch with the REAL product photos (both colourways). Its old pictures scored 8.4–8.8 (stripes across the
-- toe; shot 1 asked for WHITE with only black references) — under the 9.5 bar, so they are no longer shown.
-- Starts 20 minutes after the deploy, so the NEW worker (anchor in the batch) picks it up.
-- Every picture, the anchor too, goes through the half-price batch; they appear together when the set is done.
UPDATE public.creative_generations
   SET status = 'rejected', updated_at = now()
 WHERE project_id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND kind IN ('still', 'still_end')
   AND status = 'done';

UPDATE public.creative_projects
   SET status = 'shots', step_note = NULL, updated_at = now()
 WHERE id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND status IN ('draft', 'stills', 'shots');

INSERT INTO public.creative_jobs (tenant_id, kind, project_id, payload, requested_by, run_after, progress)
SELECT p.tenant_id, 'project_stills', p.id, '{"shots":[0,1,2,3,4,5]}'::jsonb,
       (SELECT j.requested_by FROM public.creative_jobs j WHERE j.project_id = p.id AND j.requested_by IS NOT NULL ORDER BY j.created_at DESC LIMIT 1),
       now() + interval '20 minutes', 'Drawing all 6 pictures again with the real product photos (half-price batch)'
  FROM public.creative_projects p
 WHERE p.id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = p.id AND j.kind = 'project_stills' AND j.status IN ('queued','running','waiting'));
