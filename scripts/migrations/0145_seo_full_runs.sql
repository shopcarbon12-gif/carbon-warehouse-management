-- Full SEO pass per product (lib/server/seo-full.ts), owner 2026-11-04:
-- "install all seo you used and did into the wms studio so any product moving
-- forward will be same to what we have currently".
-- One row per run. `signature` = photos (ids, in order) + colour names at the
-- time of the run; the worker watch re-runs a product when it changes.
-- status: baseline (recorded as already done by the Nov 2026 catalog pass),
--         queued | running | done | failed | skipped.
CREATE TABLE IF NOT EXISTS public.seo_full_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  matrix_id          uuid NULL,
  shopify_product_id text NOT NULL,
  handle             text NULL,
  signature          text NOT NULL DEFAULT '',
  status             text NOT NULL,
  trigger            text NOT NULL,
  job_id             uuid NULL,
  result             jsonb NULL,
  error              text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz NULL
);
CREATE INDEX IF NOT EXISTS seo_full_runs_product_idx ON public.seo_full_runs (shopify_product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS seo_full_runs_matrix_idx ON public.seo_full_runs (matrix_id, created_at DESC);
