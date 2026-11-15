-- CarbonWMS Creative — each cast model's Kling custom voice (made once, used in every clip so the same person
-- always sounds the same; owner, 2026-11-15).
ALTER TABLE public.creative_model_meta ADD COLUMN IF NOT EXISTS kling_voice_id text NULL;
