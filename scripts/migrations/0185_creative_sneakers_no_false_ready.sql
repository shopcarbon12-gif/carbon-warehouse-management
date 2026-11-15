-- CarbonWMS Creative, 2026-11-15: no Off Sneakers picture reached 9.5, but the page said "Shots ready — make the
-- video". The project goes back to "pictures" with an honest note (the code no longer cuts a draft with no picture).
UPDATE public.creative_projects
   SET status = 'stills',
       step_note = 'None of the pictures reached the 9.5 quality bar after 4 tries each — nothing is shown. Ask for a change or try again.',
       updated_at = now()
 WHERE id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND status = 'draft'
   AND NOT EXISTS (SELECT 1 FROM public.creative_generations g WHERE g.project_id = 'b098482d-add5-43f2-b5fb-f626a7b5a992' AND g.kind = 'still' AND g.status = 'done');
