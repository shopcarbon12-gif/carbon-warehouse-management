-- Desktop alerts for CarbonWMS Creative (owner, 2026-11-15: "when the batch is ready, a notification on the
-- desktop plus a sound"). Every device that already has alerts on gets the new 'creative' kind. Idempotent.
UPDATE public.web_push_subscriptions SET kinds = array_append(kinds, 'creative') WHERE NOT ('creative' = ANY(kinds));
ALTER TABLE public.web_push_subscriptions ALTER COLUMN kinds SET DEFAULT ARRAY['orders', 'studio', 'creative'];
