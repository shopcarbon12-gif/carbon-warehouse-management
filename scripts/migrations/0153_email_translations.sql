-- CarbonWMS Email — Spanish + Portuguese versions of every converted email (owner,
-- 2026-11-08: "the end result should generate the HTML with an option to translate
-- to Portuguese and to Spanish … bold enough for people to see it").
-- The English email gets a bold language bar at the top; its links open that
-- person's email in Spanish / Portuguese as a web page (mail apps cannot switch
-- the language inside an email). Translations are made after the visual check.
ALTER TABLE public.email_designs
  ADD COLUMN IF NOT EXISTS html_es text NULL,
  ADD COLUMN IF NOT EXISTS html_pt text NULL,
  ADD COLUMN IF NOT EXISTS translate_status text NULL;   -- running | done | failed

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS html_es text NULL,              -- frozen at approval, like html
  ADD COLUMN IF NOT EXISTS html_pt text NULL;
