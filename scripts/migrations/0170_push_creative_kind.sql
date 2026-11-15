-- Desktop alerts for CarbonWMS Creative (owner, 2026-11-15: "when the batch is ready, a notification on the
-- desktop plus a sound"). Devices that had alerts on got the new 'creative' kind ONCE — guarded by a marker so a
-- later deploy never switches it back on for someone who turned it off (review 2026-11-15).
CREATE TABLE IF NOT EXISTS public.creative_markers (key text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.creative_markers WHERE key = '0170_push_creative_kind') THEN
    UPDATE public.web_push_subscriptions SET kinds = array_append(kinds, 'creative') WHERE NOT ('creative' = ANY(kinds));
    INSERT INTO public.creative_markers (key) VALUES ('0170_push_creative_kind') ON CONFLICT DO NOTHING;
  END IF;
END $$;
ALTER TABLE public.web_push_subscriptions ALTER COLUMN kinds SET DEFAULT ARRAY['orders', 'studio', 'creative'];
