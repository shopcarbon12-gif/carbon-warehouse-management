-- CarbonCast: "Ask for changes" is carried out by the AI (owner, 2026-10-25).
--
-- A note sent with Ask for changes queues the post (ai_status 'queued'). The AI
-- reads the note, the post and its pictures, edits the caption, hashtags, time,
-- channels and product tags, and — when the note asks for it — has a new
-- picture made with the OpenAI batch (ai_status 'picture' until it is back).
-- Then the post returns to 'draft' (waiting for approval) with ai_summary
-- saying what changed. It is never approved by the AI.
--
-- marketing_post_changes keeps each round: the note, what the AI did, and the
-- post before it, so a change can be looked at or undone.

ALTER TABLE public.marketing_posts
  ADD COLUMN IF NOT EXISTS ai_status        text NULL,
  ADD COLUMN IF NOT EXISTS ai_summary       text NULL,
  ADD COLUMN IF NOT EXISTS ai_error         text NULL,
  ADD COLUMN IF NOT EXISTS ai_attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_requested_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS ai_requested_by  text NULL,
  ADD COLUMN IF NOT EXISTS ai_picture       jsonb NULL;

DO $$ BEGIN
  ALTER TABLE public.marketing_posts
    ADD CONSTRAINT marketing_posts_ai_status_chk CHECK (ai_status IS NULL OR ai_status IN ('queued','working','picture','done','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS marketing_posts_ai_idx ON public.marketing_posts (ai_status) WHERE ai_status IN ('queued','working','picture');

CREATE TABLE IF NOT EXISTS public.marketing_post_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES public.marketing_posts(id) ON DELETE CASCADE,
  note        text NOT NULL,
  summary     text NULL,
  plan        jsonb NULL,
  before      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_post_changes_post_idx ON public.marketing_post_changes (post_id, created_at DESC);
