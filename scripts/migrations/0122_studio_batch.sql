-- 0122_studio_batch.sql
--
-- Studio night batch (owner, 2026-10-17). "Add to batch" in a product's Studio
-- queues exactly what Generate would send for each panel (studio_batch_items).
-- The worker sends every queued item to OpenAI's Batch API at 1 AM Eastern
-- (half price, results within 24 h — usually by morning), polls the batch, and
-- saves each finished panel in the owner's Dropbox (Campaign › 2026 OPENAI
-- GENERATOR WMS). The product's Studio then shows the results for review;
-- nothing is published by itself.
--
-- studio_batches is one OpenAI batch; studio_batch_items is one product run
-- (one model, one colour, the chosen panels) inside it.

CREATE TABLE IF NOT EXISTS public.studio_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  trigger            text NOT NULL DEFAULT 'nightly',            -- nightly | manual
  status             text NOT NULL DEFAULT 'preparing',          -- preparing | submitted | validating | in_progress | finalizing | completed | processed | failed | expired | cancelled
  openai_batch_id    text NULL,
  input_file_id      text NULL,
  output_file_id     text NULL,
  error_file_id      text NULL,
  uploaded_file_ids  text[] NOT NULL DEFAULT '{}',
  request_count      integer NOT NULL DEFAULT 0,
  image_model        text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz NULL,
  completed_at       timestamptz NULL,
  processed_at       timestamptz NULL,
  last_polled_at     timestamptz NULL,
  error              text NULL
);

CREATE INDEX IF NOT EXISTS studio_batches_open_idx
  ON public.studio_batches (status)
  WHERE status IN ('preparing', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed');

CREATE TABLE IF NOT EXISTS public.studio_batch_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NULL,
  matrix_id     uuid NOT NULL REFERENCES public.matrices(id) ON DELETE CASCADE,
  -- Who pressed "Add to batch": the worker sends the night's batch under this
  -- person's session, so it runs with exactly their access.
  added_by      uuid NULL,
  added_email   text NULL,
  added_role    text NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued',                  -- queued | preparing | submitted | ready | loaded | failed | cancelled
  run_tag       text NOT NULL,
  model_name    text NULL,
  model_gender  text NULL,
  item_colour   text NULL,
  item_type     text NULL,
  -- [{ "panel": 1, "body": { …exactly the /api/generate request body… } }, …]
  panels        jsonb NOT NULL,
  batch_id      uuid NULL REFERENCES public.studio_batches(id) ON DELETE SET NULL,
  -- { "1": { "path": "...", "usage": {...} } | { "error": "..." }, … }
  results       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS studio_batch_items_matrix_idx
  ON public.studio_batch_items (matrix_id, added_at DESC);
CREATE INDEX IF NOT EXISTS studio_batch_items_status_idx
  ON public.studio_batch_items (tenant_id, status);
CREATE INDEX IF NOT EXISTS studio_batch_items_batch_idx
  ON public.studio_batch_items (batch_id);
