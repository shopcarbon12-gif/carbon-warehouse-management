-- Social: a Reel's cover picture uploaded in CarbonWMS (owner, 2026-10-25).
-- Stored on R2 next to the video and served publicly at
-- /api/public/marketing-media/<media id>-cover.jpg (Instagram's cover_url).
ALTER TABLE public.marketing_post_media ADD COLUMN IF NOT EXISTS cover_storage_path text NULL;

-- Social results (owner, 2026-10-25): what each published post did, and the
-- account over time. Refreshed by the worker (scheduler.ts) every few hours
-- for posts of the last 60 days.
ALTER TABLE public.marketing_post_targets
  ADD COLUMN IF NOT EXISTS metrics    jsonb NULL,
  ADD COLUMN IF NOT EXISTS metrics_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS public.marketing_account_stats (
  tenant_id   uuid NOT NULL,
  provider    text NOT NULL,
  account_id  text NOT NULL,
  day         date NOT NULL,
  followers   int NULL,
  reach       int NULL,
  views       int NULL,
  profile_views int NULL,
  website_clicks int NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, account_id, day)
);

-- Other channels' logins (Bluesky app password, later OAuth tokens), sealed
-- with SESSION_SECRET (lib/server/secret-box.ts) — never shown back.
ALTER TABLE public.marketing_channels ADD COLUMN IF NOT EXISTS secret text NULL;
