-- 2026-08-12 — Carbon Studio model library (M2/P2.5).
--
-- Person "models" (identity locks) for the OpenAI V2 image generator, ported
-- from carbon-gen. Models are shared across the single WMS tenant, stored under
-- a fixed user_id ('00000000-0000-0000-0000-000000000001'); ref images are
-- R2-hosted public URLs. Idempotent (the incremental runner re-applies files).
CREATE TABLE IF NOT EXISTS models (
  model_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  gender         TEXT NOT NULL,
  ref_image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_models_user_created ON models(user_id, created_at DESC);
