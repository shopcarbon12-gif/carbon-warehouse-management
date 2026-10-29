-- Social: Facebook product tags are added by hand (Meta's API cannot tag products on
-- Page posts or Reels). The owner ticks "Done" on the post's Facebook card once the
-- products are tagged there (owner, 2026-10-29: "the Facebook card").
ALTER TABLE public.marketing_post_targets ADD COLUMN IF NOT EXISTS tags_done_at timestamptz NULL;
ALTER TABLE public.marketing_post_targets ADD COLUMN IF NOT EXISTS tags_done_by text NULL;
