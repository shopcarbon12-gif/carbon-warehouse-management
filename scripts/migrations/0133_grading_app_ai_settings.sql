-- CarbonGradingAI: which areas the AI assist places (owner 2026-10-22: "a switch
-- in settings for ai on/off and if on for what — all, or just crotch and
-- sleeves, or just chest"), and what each area costs.
-- ai: {"enabled": true, "areas": {"sleeves": true, "crotch": true, "chest": true, "other": false}}
CREATE TABLE IF NOT EXISTS grading_app_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  ai jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- One row per AI assist call: the areas its points belong to (a call that
-- mixes areas splits its cost by points), the model and what it cost.
CREATE TABLE IF NOT EXISTS grading_app_ai_calls (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id uuid,
  model text NOT NULL,
  profile text NOT NULL,
  keys text[] NOT NULL,
  areas text[] NOT NULL,
  runs int NOT NULL DEFAULT 1,
  cost_usd numeric(10, 5),
  ms int
);
CREATE INDEX IF NOT EXISTS grading_app_ai_calls_model_idx ON grading_app_ai_calls (model, created_at DESC);
