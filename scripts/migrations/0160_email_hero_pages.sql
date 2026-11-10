-- CarbonWMS Email — personal hero pictures (owner's CARBON pack, template 38: the member card shows
-- each person's own name). A hero whose words hold {{first_name}} is not drawn once: its page is kept
-- here and /api/public/email/hero/<key>.jpg?n=<name> draws it the first time an inbox asks for that
-- name, then serves the stored picture (email_text_pics) to everyone else with the same name.
CREATE TABLE IF NOT EXISTS public.email_hero_pages (
  key        text PRIMARY KEY,
  page       text NOT NULL,
  bg         text NULL,
  alt        text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
