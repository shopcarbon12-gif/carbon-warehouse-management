-- Wholesale applications (owner 2026-11-03): the /pages/wholesale form on
-- shopcarbon.com still goes to Shopify (emailed to the store contact address),
-- and the page also sends a copy here, so applications show in
-- Shopify → Wholesale, raise a "Wholesale applications" alert, and can be
-- approved in one click (company + buyer created in Shopify, Shopify sends
-- the buyer its customer account invite). Store-level (one Shopify store), so no tenant.

-- Devices already signed up for alerts get the new kind — once. Decided before
-- the table exists, so a later deploy never switches it back on for someone
-- who turned it off.
DO $$ BEGIN
  IF to_regclass('public.wholesale_applications') IS NULL THEN
    UPDATE web_push_subscriptions
       SET kinds = kinds || ARRAY['wholesale']::text[], updated_at = now()
     WHERE NOT ('wholesale' = ANY(kinds));
  END IF;
END $$;

ALTER TABLE web_push_subscriptions
  ALTER COLUMN kinds SET DEFAULT ARRAY['orders', 'studio', 'visitor_new', 'visitor_back', 'visitor_checkout', 'wholesale'];

CREATE TABLE IF NOT EXISTS wholesale_applications (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'declined')),
  -- The form's fields, as the shopper typed them (email lower-cased).
  business_name text NOT NULL,
  contact_name text,
  email text NOT NULL,
  phone text,
  city_state text NOT NULL,
  website text,
  store_type text,
  message text,
  source_path text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Same email + business again (a double click, a resend): one row, updated.
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_email text,
  -- Set on approve.
  shopify_company_gid text,
  shopify_customer_gid text,
  welcome_email_sent boolean NOT NULL DEFAULT false,
  last_error text
);
CREATE INDEX IF NOT EXISTS wholesale_applications_created_idx ON wholesale_applications (created_at DESC);
CREATE INDEX IF NOT EXISTS wholesale_applications_email_idx ON wholesale_applications (email);
