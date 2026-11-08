-- CarbonWMS Email AI Designer — a different style every time (owner, 2026-11-08). Each AI version
-- records its style {structure, type, colour} (lib/server/email/styles.ts) so new versions avoid the
-- styles of the store's recent emails, and the 3 directions of one message never share one.
ALTER TABLE public.email_design_messages ADD COLUMN IF NOT EXISTS style jsonb NULL;
