-- CarbonWMS Creative — owner, 2026-11-15 ("do 1-3"):
-- (2) "Judge by eye": the owner's verdict on pictures under the 9.5 bar; the quality check calibrates to it.
CREATE TABLE IF NOT EXISTS public.creative_owner_marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  project_id    uuid,
  generation_id uuid NOT NULL UNIQUE,
  verdict       text NOT NULL CHECK (verdict IN ('pass', 'fail')),
  overall       numeric,
  fails         jsonb NOT NULL DEFAULT '[]'::jsonb,
  problems      jsonb NOT NULL DEFAULT '[]'::jsonb,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_owner_marks_tenant ON public.creative_owner_marks (tenant_id, created_at DESC);

-- (3) The Off Sneakers' signature details, checked by eye against the real Shopify photos (the shop description says
-- the stripes run "from the toe to the heel" — they don't). Every picture prompt and the check use this.
UPDATE public.creative_product_twins
   SET facts = jsonb_set(COALESCE(facts, '{}'::jsonb), '{signature}', to_jsonb(
     'SOLE WALL: the back (heel) half is white with about 7 black diagonal stripes, all slanting the same way, evenly spaced; the front (toe) half of the sole wall is solid black and finely ribbed, and that black rises into a small pointed black tip on the very front of the toe. '
     || 'UPPER: plain and smooth, one colour, NO stripes, lines or panels on the upper or on the toe box. Round toe, low top, padded collar, tonal laces through round eyelets. '
     || 'LOGO: one small geometric CARBON logo on the top of the tongue only — about the width of one eyelet pair; no other logo or text outside. '
     || 'COLOURWAYS: WHITE pair = white upper and white laces; BLACK pair = black upper and black laces; the sole (striped white heel half, black ribbed front half with the toe tip) is the same on both.'::text))
 WHERE product_id = 'gid://shopify/Product/9217356988668';

-- (1)+(3) One redraw of the sneaker creative with all of it: signature details, the shot's colourway (shot 4 named no
-- colour and came back black), and the close-up real-product pass. 20 minutes after the deploy so the NEW worker runs it.
UPDATE public.creative_projects
   SET status = 'shots', step_note = NULL, updated_at = now()
 WHERE id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND status IN ('draft', 'stills', 'shots');

INSERT INTO public.creative_jobs (tenant_id, kind, project_id, payload, requested_by, run_after, progress)
SELECT p.tenant_id, 'project_stills', p.id, '{"shots":[0,1,2,3,4,5]}'::jsonb,
       (SELECT j.requested_by FROM public.creative_jobs j WHERE j.project_id = p.id AND j.requested_by IS NOT NULL ORDER BY j.created_at DESC LIMIT 1),
       now() + interval '20 minutes', 'Drawing all 6 pictures again: exact shoe details + the real-shoe close-up pass (half-price batch)'
  FROM public.creative_projects p
 WHERE p.id = 'b098482d-add5-43f2-b5fb-f626a7b5a992'
   AND NOT EXISTS (SELECT 1 FROM public.creative_jobs j WHERE j.project_id = p.id AND j.kind = 'project_stills' AND j.status IN ('queued','running','waiting'));
