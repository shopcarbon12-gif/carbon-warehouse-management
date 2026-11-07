-- CarbonWMS Email AI Designer (owner, 2026-11-07): the real in-stock catalog
-- products a turn uses — [{id, title, url, price, image}] — so the pictures
-- show real garments and "Convert to email" links them to their real pages.
ALTER TABLE public.email_design_messages ADD COLUMN IF NOT EXISTS products jsonb NULL;
