-- CarbonWMS Email AI Designer (owner, 2026-11-07: "install all … check Shopify
-- content, you'll find all media … About Us and Store Locator pages").
-- The brand media library: every usable picture in Shopify Files (campaign
-- banners, lifestyle shots, store photos), described once by the AI so the
-- designer can pick real brand pictures. Store photos from the About Us page
-- are pinned (kind 'store') by the code, not stored here.
CREATE TABLE IF NOT EXISTS public.email_media (
  file_gid      text PRIMARY KEY,
  url           text NOT NULL,
  width         integer NOT NULL,
  height        integer NOT NULL,
  alt           text NULL,
  file_created  timestamptz NULL,
  -- filled by the describer; NULL = not looked at yet
  described_at  timestamptz NULL,
  kind          text NULL,            -- campaign | lifestyle | model | product | store | graphic | text | other
  description   text NULL,
  usable        boolean NULL,         -- a clean photo an email may use (no words, no notices, no icons)
  error         text NULL,
  seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_media_usable_idx ON public.email_media (usable, file_created DESC);
CREATE INDEX IF NOT EXISTS email_media_todo_idx ON public.email_media (described_at) WHERE described_at IS NULL;

-- When the library last looked at Shopify Files (one row per install).
CREATE TABLE IF NOT EXISTS public.email_media_sync (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  listed_at   timestamptz NULL,
  files_seen  integer NOT NULL DEFAULT 0
);
INSERT INTO public.email_media_sync (id) VALUES (1) ON CONFLICT DO NOTHING;

-- The brand pictures (store photos, campaign shots) a design turn uses.
ALTER TABLE public.email_design_messages ADD COLUMN IF NOT EXISTS media jsonb NULL;
