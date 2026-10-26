-- Social: every AI action (Write with AI, caption check, weekly review, making Stories) is a
-- job saved here first and finished by the server in the background, so a
-- refresh, a closed tab or a deploy never loses it (owner, 2026-10-26).
CREATE TABLE IF NOT EXISTS public.marketing_ai_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  post_id       uuid NULL REFERENCES public.marketing_posts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued',
  result        jsonb NULL,
  error         text NULL,
  attempts      int NOT NULL DEFAULT 0,
  requested_by  text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_ai_jobs_kind_chk CHECK (kind IN ('write', 'check', 'weekly_review', 'stories')),
  CONSTRAINT marketing_ai_jobs_status_chk CHECK (status IN ('queued', 'working', 'done', 'failed', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS marketing_ai_jobs_open_idx ON public.marketing_ai_jobs (status, created_at) WHERE status IN ('queued', 'working');
CREATE INDEX IF NOT EXISTS marketing_ai_jobs_post_idx ON public.marketing_ai_jobs (post_id, kind, created_at DESC);

-- The weekly review of what worked (Results page), one per tenant and week (Monday, Eastern).
CREATE TABLE IF NOT EXISTS public.marketing_weekly_reviews (
  tenant_id   uuid NOT NULL,
  week_start  date NOT NULL,
  review      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, week_start)
);
