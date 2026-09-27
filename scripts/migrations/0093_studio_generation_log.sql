-- Studio generation log.
--
-- Nothing recorded a generation: not the model used, the size, the QA verdict,
-- nor whether the operator kept the result. So every question about the Studio
-- was unanswerable — "is rendering poses separately worth 50% more", "which
-- model drifts most", "how often does a prompt overflow", "what does a product
-- actually cost" — and the answers were guesses on both sides.
--
-- One row per panel generation, written best-effort AFTER the image is served
-- so a logging failure can never cost a paid render.

CREATE TABLE IF NOT EXISTS studio_generations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  tenant_id      uuid,
  location_id    uuid,

  -- what was asked for
  matrix_id      uuid,
  item_type      text,
  model_name     text,
  model_gender   text,
  panel_number   integer,
  pose_a         integer,
  pose_b         integer,

  -- how it was rendered (the levers we may change)
  image_model    text,
  image_quality  text,
  image_size     text,
  model_ref_count integer,
  item_ref_count  integer,
  prompt_bytes    integer,
  prompt_trimmed  boolean NOT NULL DEFAULT false,

  -- what came back
  outcome        text NOT NULL,           -- 'ok' | 'failed' | 'blocked'
  duration_ms    integer,
  qa_decisive    boolean,
  qa_pass        boolean,
  qa_warnings    integer NOT NULL DEFAULT 0,
  back_unknown   boolean NOT NULL DEFAULT false,
  error_code     text
);

-- "what happened lately", the only access pattern so far.
CREATE INDEX IF NOT EXISTS studio_generations_created_idx
  ON studio_generations (created_at DESC);
-- per-product and per-model rollups
CREATE INDEX IF NOT EXISTS studio_generations_matrix_idx
  ON studio_generations (matrix_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_generations_model_idx
  ON studio_generations (model_name, created_at DESC);
