-- CarbonWMS Creative — each cast model's voice on fal's Kling 4.0 (owner switched video to fal, 2026-11-15).
-- Voices made on the owner's own Kling account (kling_voice_id) don't exist on fal, so fal gets its own id.
ALTER TABLE public.creative_model_meta ADD COLUMN IF NOT EXISTS fal_voice_id text NULL;
