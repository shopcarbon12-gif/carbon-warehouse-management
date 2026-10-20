-- Email Popup: the footer newsletter now uses the same signup as the popup
-- (owner 2026-10-20: "combine the newsletter with this"). Record which form
-- each signup came from for Shopify → Email Popup.
ALTER TABLE welcome_signups
  ADD COLUMN IF NOT EXISTS form text NOT NULL DEFAULT 'popup';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'welcome_signups_form_ck') THEN
    ALTER TABLE welcome_signups ADD CONSTRAINT welcome_signups_form_ck CHECK (form IN ('popup', 'footer'));
  END IF;
END $$;
