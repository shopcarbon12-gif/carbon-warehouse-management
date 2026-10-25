-- 0136_carbon_marketing.sql
--
-- CarbonMarketing (owner, 2026-10-24): one place to plan, approve and publish
-- posts to every social channel, starting with Instagram (with Instagram Shop
-- product tags) and the Facebook page for the AW2026 campaign.
--
-- 1. marketing_settings: one row per tenant. publish_enabled is the kill switch
--    and starts OFF; nothing leaves the CarbonWMS until an admin turns it on.
-- 2. marketing_channels: one row per connected account (instagram, facebook,
--    tiktok, pinterest, youtube, google_business, linkedin, x, threads,
--    bluesky, merchant_center). Secrets stay in env vars; this row holds the
--    account id, display name and health.
-- 3. marketing_posts: the calendar. A post can only publish when a person
--    approved THAT post (approved_by is set) and its time has come.
-- 4. marketing_post_media / marketing_post_tags: the pictures or video in post
--    order, and the Instagram product tags per picture.
-- 5. marketing_post_targets: one row per channel the post goes to, with the
--    result (remote id, permalink, error) of each attempt.
-- 6. marketing_best_times: audience activity per channel, weekday and hour,
--    used to suggest posting times.

CREATE TABLE IF NOT EXISTS public.marketing_settings (
  tenant_id       uuid PRIMARY KEY,
  publish_enabled boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NULL
);

CREATE TABLE IF NOT EXISTS public.marketing_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  provider     text NOT NULL,
  account_id   text NOT NULL,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'connected',
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz NULL,
  last_error   text NULL,
  UNIQUE (tenant_id, provider, account_id)
);

CREATE TABLE IF NOT EXISTS public.marketing_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  campaign     text NULL,
  source_ref   text NULL,
  title        text NOT NULL DEFAULT '',
  format       text NOT NULL DEFAULT 'image',
  caption      text NOT NULL DEFAULT '',
  hashtags     text[] NOT NULL DEFAULT '{}',
  link_url     text NULL,
  scheduled_at timestamptz NULL,
  status       text NOT NULL DEFAULT 'draft',
  note         text NULL,
  approved_by  text NULL,
  approved_at  timestamptz NULL,
  created_by   text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_posts_format_chk CHECK (format IN ('image','carousel','reel','story')),
  CONSTRAINT marketing_posts_status_chk CHECK (status IN ('draft','changes_requested','approved','publishing','published','partly_published','failed','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_posts_source_uq ON public.marketing_posts (tenant_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_posts_due_idx ON public.marketing_posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS public.marketing_post_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES public.marketing_posts(id) ON DELETE CASCADE,
  position     int NOT NULL,
  kind         text NOT NULL DEFAULT 'image',
  url          text NOT NULL,
  storage_path text NULL,
  dropbox_path text NULL,
  cover_url    text NULL,
  UNIQUE (post_id, position),
  CONSTRAINT marketing_post_media_kind_chk CHECK (kind IN ('image','video'))
);

CREATE TABLE IF NOT EXISTS public.marketing_post_tags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid NOT NULL REFERENCES public.marketing_posts(id) ON DELETE CASCADE,
  media_position   int NOT NULL,
  meta_product_id  text NOT NULL,
  shopify_handle   text NULL,
  label            text NOT NULL DEFAULT '',
  x                numeric NOT NULL DEFAULT 0.5,
  y                numeric NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS marketing_post_tags_post_idx ON public.marketing_post_tags (post_id, media_position);

CREATE TABLE IF NOT EXISTS public.marketing_post_targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES public.marketing_posts(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  remote_id     text NULL,
  permalink     text NULL,
  error         text NULL,
  attempts      int NOT NULL DEFAULT 0,
  published_at  timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, provider),
  CONSTRAINT marketing_post_targets_status_chk CHECK (status IN ('pending','publishing','published','failed','skipped'))
);

CREATE TABLE IF NOT EXISTS public.marketing_best_times (
  tenant_id   uuid NOT NULL,
  provider    text NOT NULL,
  weekday     int NOT NULL,
  hour        int NOT NULL,
  score       numeric NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, weekday, hour)
);
