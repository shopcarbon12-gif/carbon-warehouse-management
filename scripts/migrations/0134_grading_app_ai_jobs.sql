-- CarbonGradingAI: every AI placement goes through OpenAI's Batch API (half
-- price), sent the moment a scan is saved — not at night (owner 2026-10-22:
-- "make sure that any ai through the grading app is going through batch and
-- not in 1 am but at the moment we ready to send").
--
-- One job = one AI placement on one photo of a saved scan (the crotch /
-- sleeves-up photo takes two runs, a third when they disagree). The agent asks
-- for close-ups over several rounds; each round is one batch request, and the
-- job is replayed with the answers it has to build the next one.
CREATE TABLE IF NOT EXISTS grading_ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  scan_id uuid NOT NULL REFERENCES size_grading_scans (id) ON DELETE CASCADE,
  photo text NOT NULL,              -- main | second
  run int NOT NULL DEFAULT 0,       -- 0, 1 (second photo's two runs), 2 (tie-break)
  profile text NOT NULL,
  keys text[] NOT NULL,
  px_per_cm numeric NOT NULL,
  model text NOT NULL,
  -- waiting: the next round is to be sent · sent: with OpenAI · done · failed · cancelled
  status text NOT NULL DEFAULT 'waiting',
  answers jsonb NOT NULL DEFAULT '[]'::jsonb,       -- the AI's reply text of each round so far
  response_ids jsonb NOT NULL DEFAULT '[]'::jsonb,  -- OpenAI response id of each round
  full_history boolean NOT NULL DEFAULT false,      -- send the whole conversation (a round could not point at the last answer)
  openai_batch_id text,
  custom_id text,
  tries int NOT NULL DEFAULT 0,
  usage jsonb NOT NULL DEFAULT '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}'::jsonb,
  cost_usd numeric(10, 5),
  result jsonb,                     -- {lines, skipped, remarks, rounds, zooms}
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  done_at timestamptz
);
CREATE INDEX IF NOT EXISTS grading_ai_jobs_open_idx ON grading_ai_jobs (status) WHERE status IN ('waiting', 'sent');
CREATE INDEX IF NOT EXISTS grading_ai_jobs_scan_idx ON grading_ai_jobs (scan_id);

-- The scan's AI state for the review list and the phone: null (no AI), pending, done, failed.
ALTER TABLE size_grading_scans ADD COLUMN IF NOT EXISTS ai_status text;
