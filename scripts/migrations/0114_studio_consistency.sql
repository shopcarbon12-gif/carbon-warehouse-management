-- Studio consistency upgrade (2026-10-14): panel 1 sets the look, a stored
-- look per model and colour, and the numbers needed to judge it.
--
-- The four panels of a run are four independent image calls, so whatever the
-- prompt leaves open is drawn four different ways. Panel 1 now renders first
-- and panels 2-4 attach it as a same-shoot reference; an approved panel 1 is
-- kept per (model, colour) so a later one-panel re-render can match the crops
-- it is kept beside. Cost was never measurable because OpenAI's `usage` was
-- discarded; it is now kept per panel.
--
-- Idempotent (IF NOT EXISTS) — the app also tolerates these columns being
-- absent, so a failed migration costs the new log fields, not the Studio.

-- Stored look anchors, keyed "<modelId>|<COLOUR>":
--   { "<key>": { "url", "runTag", "at", "modelId", "colour", "gate" } }
-- gate = null (not judged) | pass | flagged | forced | unavailable.
ALTER TABLE studio_matrix_state
  ADD COLUMN IF NOT EXISTS look_anchors jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE studio_generations
  ADD COLUMN IF NOT EXISTS usage            jsonb,    -- OpenAI images.edit usage (input text/image tokens, output tokens)
  ADD COLUMN IF NOT EXISTS anchor_role      text,     -- 'source' | 'follower' | 'stored' | NULL (not anchored)
  ADD COLUMN IF NOT EXISTS anchor_wait_ms   integer,  -- how long a follower waited for panel 1
  ADD COLUMN IF NOT EXISTS anchor_gate      text,     -- 'pass' | 'flagged' | 'forced' | 'unavailable'
  ADD COLUMN IF NOT EXISTS variation_seed   bigint,   -- the pose-variation seed actually used
  ADD COLUMN IF NOT EXISTS look_sheet_bytes integer,  -- size of the run's look sheet, NULL when none was sent
  ADD COLUMN IF NOT EXISTS images_dropped   jsonb,    -- reference photos left out for the 16-image limit, per section
  ADD COLUMN IF NOT EXISTS run_tag          text;     -- the Studio run (x-generate-run), so a run's panels group exactly

CREATE INDEX IF NOT EXISTS studio_generations_run_tag_idx
  ON studio_generations (run_tag)
  WHERE run_tag IS NOT NULL;
