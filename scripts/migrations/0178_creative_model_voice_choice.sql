-- CarbonWMS Creative — the owner's voice choice per model (2026-11-15): Kling's natural voice (NULL), a voice from
-- Kling's voice-actor library ('library'), or an uploaded recording ('recording'); fal_voice_id holds the fal voice.
ALTER TABLE public.creative_model_meta ADD COLUMN IF NOT EXISTS voice_source text NULL;
ALTER TABLE public.creative_model_meta ADD COLUMN IF NOT EXISTS voice_label text NULL;
