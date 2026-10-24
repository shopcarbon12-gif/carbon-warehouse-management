-- 0135_model_fit.sql
--
-- Studio size fit (owner, 2026-10-24): before generating, the Studio checks the
-- product's measured sizes against the model's body, picks the size the model
-- would really wear and draws that fit. When the pictures are pushed to
-- Shopify, the product records the model and that size.
--
-- 1. model_profiles gets inseam, shoulder width and shoe size. Values are the
--    owner's model table, written ONCE (only while inseam_in is still empty),
--    so a later edit is never overwritten by a redeploy. Agreed fixes in the
--    same pass: Victor's chest 41" (his 19" shoulders and build match Rico's,
--    not Gringo's 40"), and the men's missing hips (39"). Everything else
--    already matched the owner's table and is left as stored.
-- 2. studio_size_fits remembers the size each product was last generated in
--    per model, for the Shopify push.

ALTER TABLE public.model_profiles ADD COLUMN IF NOT EXISTS inseam_in   numeric NULL;
ALTER TABLE public.model_profiles ADD COLUMN IF NOT EXISTS shoulder_in numeric NULL;
ALTER TABLE public.model_profiles ADD COLUMN IF NOT EXISTS shoe_us     text NULL;

UPDATE public.model_profiles p
   SET inseam_in = v.inseam, shoulder_in = v.shoulder, shoe_us = v.shoe,
       hips_in = COALESCE(p.hips_in, v.hips),
       bust_or_chest_in = CASE WHEN v.chest IS NOT NULL THEN v.chest ELSE p.bust_or_chest_in END,
       updated_at = now()
  FROM (VALUES
    ('elena',   32::numeric, 15.5::numeric, '8',    NULL::numeric, NULL::numeric),
    ('zara',    31, 15.5, '7.5',  NULL, NULL),
    ('daniela', 32, 15.5, '8',    NULL, NULL),
    ('jaylen',  33, 18.5, '11',   NULL, NULL),
    ('finn',    33, 18.5, '11',   NULL, NULL),
    ('nico',    32, 18.5, '10.5', NULL, NULL),
    ('latina',  32, 15.5, '8',    NULL, NULL),
    ('gringa',  32, 15,   '8',    NULL, NULL),
    ('afro',    31, 15.5, '7.5',  NULL, NULL),
    ('gringo',  33, 18.5, '11',   39,   NULL),
    ('rico',    33, 19,   '11',   39,   NULL),
    ('victor',  33, 19,   '11',   39,   41)
  ) AS v(name, inseam, shoulder, shoe, hips, chest)
 WHERE lower(p.studio_model_name) = v.name
   AND p.inseam_in IS NULL;

CREATE TABLE IF NOT EXISTS public.studio_size_fits (
  matrix_id    uuid NOT NULL REFERENCES public.matrices(id) ON DELETE CASCADE,
  model_name   text NOT NULL,
  size         text NOT NULL,
  basis        text NOT NULL,                 -- measurements | instruction
  summary      text NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (matrix_id, model_name)
);
