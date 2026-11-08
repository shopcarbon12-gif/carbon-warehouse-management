-- CarbonWMS Email AI Designer, back to drawn pictures (owner, 2026-11-08):
--  * pictures at the size a customer sees them: desktop 1200 px wide (600 px
--    email @2x), phone 1120 px wide (375 px @3x) drawn as a top part and a
--    bottom part (mobile_top_path) joined into one tall phone picture;
--  * "approve the items first": the AI picks the products / brand pictures,
--    stops at status 'review' (needs_review), the owner removes / swaps / adds,
--    approves (status 'approved' → 'approved-planning'), and only then the
--    pictures are drawn;
--  * a version can start from a blank page (fresh) for new directions;
--  * 3 directions no longer have to be picked: the chat continues from the
--    picked one, or from direction 1.
ALTER TABLE public.email_design_messages
  ADD COLUMN IF NOT EXISTS mobile_top_path text    NULL,
  ADD COLUMN IF NOT EXISTS fresh           boolean NULL,
  ADD COLUMN IF NOT EXISTS needs_review    boolean NULL,
  ADD COLUMN IF NOT EXISTS concept         text    NULL,         -- the picture being drawn now (desktop | mobile-top | mobile-bottom)
  ADD COLUMN IF NOT EXISTS step_at         timestamptz NULL;     -- when the turn last started a step (restart recovery)

DROP INDEX IF EXISTS public.email_design_messages_open_idx;
CREATE INDEX IF NOT EXISTS email_design_messages_open_idx ON public.email_design_messages (status)
  WHERE status IN ('queued','planning','generating','review','approved','approved-planning');
