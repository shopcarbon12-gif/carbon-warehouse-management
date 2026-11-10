-- CarbonWMS Creative — the CARBON Creative Engine (owner's master spec v2, 2026-11-09).
-- Radar (winning clothing + shoe ads), Brand Brain, Product Twins, casting, the Creative
-- Director, renders, campaigns, chat edits, ideas and the learning loop. Publishing goes
-- through CarbonCast (marketing_posts). Idempotent: the incremental runner re-applies files.

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm not available (%), Radar search falls back to ILIKE', SQLERRM;
END $$;

-- Settings: caps, routing overrides, source switches. One row per tenant.
CREATE TABLE IF NOT EXISTS public.creative_settings (
  tenant_id        uuid PRIMARY KEY,
  caps             jsonb NOT NULL DEFAULT '{"openai":{"daily":10,"monthly":100},"fal":{"daily":15,"monthly":150}}'::jsonb,
  routing          jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources          jsonb NOT NULL DEFAULT '{}'::jsonb,
  category_options jsonb NOT NULL DEFAULT '{"bags":false,"hats":false,"belts":false}'::jsonb,
  retention_days   int NOT NULL DEFAULT 180,
  meta_countries   text[] NOT NULL DEFAULT '{DE,FR,IT,ES,NL}',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NULL
);

-- Brand Brain: logos, fonts, colours, presets, voice, do/don't, edit style.
CREATE TABLE IF NOT EXISTS public.creative_brand (
  tenant_id     uuid PRIMARY KEY,
  logos         jsonb NOT NULL DEFAULT '{}'::jsonb,
  fonts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  colors        jsonb NOT NULL DEFAULT '{}'::jsonb,
  presets       jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_preset text NOT NULL DEFAULT 'street',
  voice         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dos           text[] NOT NULL DEFAULT '{}',
  donts         text[] NOT NULL DEFAULT '{}',
  edit_style    jsonb NOT NULL DEFAULT '{}'::jsonb,
  platform      jsonb NOT NULL DEFAULT '{"default":"instagram","tiktok":false}'::jsonb,
  wizard_done   boolean NOT NULL DEFAULT false,
  learned       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NULL
);

CREATE TABLE IF NOT EXISTS public.creative_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  preset      text NULL,
  image_url   text NULL,
  storage_path text NULL,
  source      text NOT NULL DEFAULT 'ai',  -- ai | upload
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_locations_tenant_idx ON public.creative_locations (tenant_id, created_at);

-- Music + SFX library (files on R2, tagged by mood and BPM).
CREATE TABLE IF NOT EXISTS public.creative_audio (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  kind         text NOT NULL DEFAULT 'music', -- music | sfx
  name         text NOT NULL,
  storage_path text NOT NULL,
  duration_s   real NULL,
  bpm          real NULL,
  beats        jsonb NULL,   -- beat times in seconds
  moods        text[] NOT NULL DEFAULT '{}',
  license      text NOT NULL DEFAULT 'owner',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creative_audio_kind_chk CHECK (kind IN ('music','sfx'))
);
CREATE INDEX IF NOT EXISTS creative_audio_tenant_idx ON public.creative_audio (tenant_id, kind);

-- ------------------------------------------------------------------ Radar
CREATE TABLE IF NOT EXISTS public.creative_ad_brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  lane        text NULL,
  status      text NOT NULL DEFAULT 'active',  -- active | pending | rejected | disabled
  prior       text NOT NULL DEFAULT 'apparel', -- advertiser prior: apparel | footwear | mixed | unknown
  meta_page_ids text[] NOT NULL DEFAULT '{}',
  handles     jsonb NOT NULL DEFAULT '{}'::jsonb,
  found_by    text NULL,
  last_refreshed_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creative_ad_brands_status_chk CHECK (status IN ('active','pending','rejected','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS creative_ad_brands_name_uq ON public.creative_ad_brands (tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS public.creative_ads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  brand_id        uuid NULL REFERENCES public.creative_ad_brands(id) ON DELETE SET NULL,
  advertiser      text NOT NULL,
  headline        text NOT NULL DEFAULT '',
  headline_norm   text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  cta             text NULL,
  landing_url     text NULL,
  landing_shot_path text NULL,
  media_type      text NULL,       -- static | carousel | video | ugc | animated
  media           jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{kind, storage_path, w, h, duration}]
  phash           text NULL,
  platforms       text[] NOT NULL DEFAULT '{}',
  sources         text[] NOT NULL DEFAULT '{}',
  countries       text[] NOT NULL DEFAULT '{}',
  first_seen      date NULL,
  last_seen       date NULL,
  is_active       boolean NULL,
  variation_count int NOT NULL DEFAULT 1,
  metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- public activity signals only (e.g. TikTok top-ads)
  category        jsonb NULL,       -- classifier result
  status          text NOT NULL DEFAULT 'new', -- new | kept | review | rejected
  reject_reason   text NULL,
  tags            jsonb NULL,
  tagged_at       timestamptz NULL,
  embedding       real[] NULL,
  winner_score    real NULL,
  search_text     text NOT NULL DEFAULT '',
  media_purged_at timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creative_ads_status_chk CHECK (status IN ('new','kept','review','rejected'))
);
CREATE INDEX IF NOT EXISTS creative_ads_list_idx ON public.creative_ads (tenant_id, status, winner_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS creative_ads_phash_idx ON public.creative_ads (tenant_id, phash);
CREATE INDEX IF NOT EXISTS creative_ads_fts_idx ON public.creative_ads USING gin (to_tsvector('simple', search_text));
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS creative_ads_trgm_idx ON public.creative_ads USING gin (search_text gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'trigram index skipped (%)', SQLERRM;
END $$;

-- One row per source sighting (a variation). Duplicates collapse onto one creative_ads row.
CREATE TABLE IF NOT EXISTS public.creative_ad_variations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_id       uuid NOT NULL REFERENCES public.creative_ads(id) ON DELETE CASCADE,
  source      text NOT NULL,
  external_id text NOT NULL,
  platform    text NULL,
  source_url  text NULL,
  headline    text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  media       jsonb NOT NULL DEFAULT '[]'::jsonb,
  phash       text NULL,
  raw         jsonb NULL,
  first_seen  date NULL,
  last_seen   date NULL,
  is_active   boolean NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS creative_ad_variations_uq ON public.creative_ad_variations (source, external_id);
CREATE INDEX IF NOT EXISTS creative_ad_variations_ad_idx ON public.creative_ad_variations (ad_id);

CREATE TABLE IF NOT EXISTS public.creative_boards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.creative_board_items (
  board_id   uuid NOT NULL REFERENCES public.creative_boards(id) ON DELETE CASCADE,
  ad_id      uuid NOT NULL REFERENCES public.creative_ads(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, ad_id)
);

-- Per-source run logs with real numbers (discovered / kept / review / rejected / merged).
CREATE TABLE IF NOT EXISTS public.creative_source_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  source      text NOT NULL,
  brand_id    uuid NULL,
  status      text NOT NULL DEFAULT 'running', -- running | done | failed
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejections  jsonb NOT NULL DEFAULT '[]'::jsonb,
  error       text NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS creative_source_runs_idx ON public.creative_source_runs (tenant_id, started_at DESC);

-- ------------------------------------------------------------------ Products + people
CREATE TABLE IF NOT EXISTS public.creative_product_twins (
  tenant_id    uuid NOT NULL,
  product_id   text NOT NULL,           -- Shopify product GID
  handle       text NOT NULL DEFAULT '',
  title        text NOT NULL DEFAULT '',
  facts        jsonb NOT NULL DEFAULT '{}'::jsonb, -- the ONLY facts the copywriter may use
  source_images jsonb NOT NULL DEFAULT '[]'::jsonb,
  cutouts      jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{angle, storage_path, from}]
  details      jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{kind, storage_path}]
  status       text NOT NULL DEFAULT 'new',  -- new | building | ready | confirmed | no_images | failed
  error        text NULL,
  confirmed_by text NULL,
  confirmed_at timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id)
);

-- Creative-side details for the Studio's models table (models.model_id).
CREATE TABLE IF NOT EXISTS public.creative_model_meta (
  tenant_id    uuid NOT NULL,
  model_id     text NOT NULL,
  age_range    text NULL,
  look         text NULL,
  body_type    text NULL,
  hair         text NULL,
  lanes        text[] NOT NULL DEFAULT '{}',
  voice        text NULL,         -- TTS voice id
  personality  text NULL,
  is_real_person boolean NOT NULL DEFAULT false,
  consent      boolean NOT NULL DEFAULT false,
  consent_by   text NULL,
  consent_at   timestamptz NULL,
  pinned       boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, model_id)
);

-- ------------------------------------------------------------------ Recipes + projects
CREATE TABLE IF NOT EXISTS public.creative_recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  key         text NOT NULL,
  name        text NOT NULL,
  idea        text NOT NULL DEFAULT '',
  media_types text[] NOT NULL DEFAULT '{video}',
  structure   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'active', -- active | proposed | retired
  source_ad_id uuid NULL,
  score       real NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS creative_recipes_key_uq ON public.creative_recipes (tenant_id, key);

CREATE TABLE IF NOT EXISTS public.creative_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  products    text[] NOT NULL DEFAULT '{}',
  hero_project_id uuid NULL,
  plan        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'draft',
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creative_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  campaign_id uuid NULL REFERENCES public.creative_campaigns(id) ON DELETE SET NULL,
  role        text NULL,          -- campaign piece: hero | cutdown | ugc | static | carousel | story | animated
  title       text NOT NULL DEFAULT '',
  kind        text NOT NULL,      -- static | video | ugc | animated
  products    text[] NOT NULL DEFAULT '{}',
  cast_ids    text[] NOT NULL DEFAULT '{}',
  preset      text NOT NULL DEFAULT 'street',
  inspiration_ad_id uuid NULL,
  brief       jsonb NULL,
  concepts    jsonb NULL,         -- the 3 concept cards
  concept_idx int NULL,
  shot_list   jsonb NULL,
  edit_plan   jsonb NULL,
  script      jsonb NULL,         -- UGC script
  captions    jsonb NULL,
  status      text NOT NULL DEFAULT 'brief', -- brief | concepts | shots | stills | clips | draft | final | failed
  step_note   text NULL,
  sizes       text[] NOT NULL DEFAULT '{4:5,9:16}',
  ai_generated boolean NOT NULL DEFAULT true,
  feedback    text NULL,          -- up | down
  idea_id     uuid NULL,
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creative_projects_kind_chk CHECK (kind IN ('static','video','ugc','animated'))
);
CREATE INDEX IF NOT EXISTS creative_projects_tenant_idx ON public.creative_projects (tenant_id, updated_at DESC);

-- Every paid or rendered thing: stills, clips, voices, renders. cost_usd always stored.
CREATE TABLE IF NOT EXISTS public.creative_generations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  project_id   uuid NULL REFERENCES public.creative_projects(id) ON DELETE CASCADE,
  kind         text NOT NULL,     -- still | tryon | clip | voice | lipsync | render | cutout | location | candidate | sample
  shot_idx     int NULL,
  size         text NULL,
  provider     text NOT NULL,
  model        text NULL,
  prompt       text NULL,
  inputs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_id  text NULL,
  status       text NOT NULL DEFAULT 'queued', -- queued | running | done | failed | rejected | cancelled
  output_path  text NULL,
  output_meta  jsonb NULL,
  cost_usd     numeric(10,4) NULL,
  critic       jsonb NULL,
  attempt      int NOT NULL DEFAULT 1,
  draft        boolean NOT NULL DEFAULT false,
  ai_generated boolean NOT NULL DEFAULT true,
  error        text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_generations_project_idx ON public.creative_generations (project_id, kind, shot_idx);
CREATE INDEX IF NOT EXISTS creative_generations_open_idx ON public.creative_generations (status) WHERE status IN ('queued','running');

-- Jobs with visible status (queued/running/done/failed + plain-English error).
CREATE TABLE IF NOT EXISTS public.creative_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  kind        text NOT NULL,
  project_id  uuid NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued', -- queued | running | waiting | done | failed | paused
  progress    text NULL,
  error       text NULL,
  result      jsonb NULL,
  attempts    int NOT NULL DEFAULT 0,
  run_after   timestamptz NOT NULL DEFAULT now(),
  requested_by text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creative_jobs_status_chk CHECK (status IN ('queued','running','waiting','done','failed','paused','cancelled'))
);
CREATE INDEX IF NOT EXISTS creative_jobs_due_idx ON public.creative_jobs (status, run_after);
CREATE INDEX IF NOT EXISTS creative_jobs_tenant_idx ON public.creative_jobs (tenant_id, created_at DESC);

-- Spend ledger (cost_usd per provider per call).
CREATE TABLE IF NOT EXISTS public.creative_spend (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  provider    text NOT NULL,   -- openai | fal
  what        text NOT NULL,
  cost_usd    numeric(10,4) NOT NULL,
  estimated   boolean NOT NULL DEFAULT false,
  project_id  uuid NULL,
  generation_id uuid NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_spend_idx ON public.creative_spend (tenant_id, provider, created_at);

-- Feedback: 👍/👎, skips, chat edits.
CREATE TABLE IF NOT EXISTS public.creative_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  target      text NOT NULL,   -- project | concept | caption | idea | generation | voice_sample
  target_id   text NOT NULL,
  verdict     text NOT NULL,   -- up | down | skip | edit
  note        text NULL,
  meta        jsonb NULL,
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_feedback_idx ON public.creative_feedback (tenant_id, target, created_at DESC);

-- Chat edits on a result: the request, the mapped change, what was re-rendered.
CREATE TABLE IF NOT EXISTS public.creative_chat (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES public.creative_projects(id) ON DELETE CASCADE,
  role        text NOT NULL,   -- owner | app
  text        text NOT NULL,
  change      jsonb NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_chat_idx ON public.creative_chat (project_id, created_at);

-- "Give me ideas" — text-only cards, one LLM call per tap.
CREATE TABLE IF NOT EXISTS public.creative_ideas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  idea        text NOT NULL,
  reason      text NOT NULL,
  prefill     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'new', -- new | made | skipped
  cost_usd    numeric(10,4) NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_ideas_idx ON public.creative_ideas (tenant_id, created_at DESC);

-- Link CarbonCast posts back to the creative they carry (learning loop).
CREATE TABLE IF NOT EXISTS public.creative_posts (
  post_id     uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES public.creative_projects(id) ON DELETE CASCADE,
  recipe_key  text NULL,
  model_ids   text[] NOT NULL DEFAULT '{}',
  preset      text NULL,
  music_mood  text NULL,
  hook        text NULL,
  results     jsonb NULL,
  sales       jsonb NULL,
  results_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The Studio adds models.ref_slots at runtime (lib/modelsRepository.ts); Casting reads it too.
DO $$ BEGIN
  IF to_regclass('public.models') IS NOT NULL THEN
    ALTER TABLE public.models ADD COLUMN IF NOT EXISTS ref_slots jsonb;
  END IF;
END $$;
