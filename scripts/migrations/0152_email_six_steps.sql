-- CarbonWMS Email AI Designer, the six-step process (owner, 2026-11-08):
--   1 concept (creative-director model, e.g. GPT-6 Astra) — no HTML
--   2 comps (picture model, real photos pasted into colour boxes)
--   3 photo assets made once per concept (hero + 3 looks), checked
--   4 HTML (Convert to email, unchanged)
--   5 render desktop + phone screenshots, visual review by the creative model
--   6 fix and re-check (max 2 rounds); the email is only "ready" when it passes
ALTER TABLE public.email_settings
  ADD COLUMN IF NOT EXISTS creative_model text NOT NULL DEFAULT 'gpt-6-astra',
  ADD COLUMN IF NOT EXISTS image_model    text NOT NULL DEFAULT 'gpt-image-2.5-sunburst';

ALTER TABLE public.email_design_messages
  ADD COLUMN IF NOT EXISTS concept_data   jsonb NULL,   -- the editorial concept (story, hero, 3 looks, offer, showroom); "concept" (text) is the picture being drawn
  ADD COLUMN IF NOT EXISTS shots          jsonb NULL,   -- photo assets: [{id, kind, size, prompt, products, path, qa}]
  ADD COLUMN IF NOT EXISTS creative_model text  NULL,   -- which model made the concept (for comparing)
  ADD COLUMN IF NOT EXISTS image_model    text  NULL;

ALTER TABLE public.email_designs
  ADD COLUMN IF NOT EXISTS check_status   text  NULL,   -- running | passed | failed
  ADD COLUMN IF NOT EXISTS check_rounds   jsonb NULL,   -- [{round, pass, score, issues, desktop, mobile, model, at}]
  ADD COLUMN IF NOT EXISTS check_override boolean NOT NULL DEFAULT false;  -- owner: "use it anyway"
