-- Email Popup (Shopify → Email Popup, owner 2026-10-20): our own email signup
-- popup on shopcarbon.com, replacing the pop-convert app. A shopper leaves an
-- email → subscribed to email marketing in Shopify + ONE unique, single-use
-- code locked to that email (no stacking with other discounts, never on
-- shipping). Store-level (one Shopify store), so no tenant.

-- One row. The theme reads a copy of these settings from the shop metafield
-- carbon.welcome_popup (written by the WMS on save), so on/off and the percent
-- change without a theme deploy.
CREATE TABLE IF NOT EXISTS welcome_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- off = the popup never opens by itself (?carbon_welcome=preview still shows it)
  enabled boolean NOT NULL DEFAULT false,
  percent_off integer NOT NULL DEFAULT 10 CHECK (percent_off BETWEEN 1 AND 50),
  valid_days integer NOT NULL DEFAULT 30 CHECK (valid_days BETWEEN 1 AND 365),
  delay_seconds integer NOT NULL DEFAULT 8 CHECK (delay_seconds BETWEEN 0 AND 120),
  send_email boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_email text
);
INSERT INTO welcome_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per email, ever: a second signup with the same email gets the same
-- code (re-emailed), never a new one.
CREATE TABLE IF NOT EXISTS welcome_signups (
  id bigserial PRIMARY KEY,
  email text NOT NULL,                       -- lower-cased
  shopify_customer_gid text,
  existing_customer boolean NOT NULL DEFAULT false,  -- was already a Shopify customer
  code text NOT NULL,
  discount_gid text NOT NULL,
  percent_off integer NOT NULL,
  ends_at timestamptz NOT NULL,
  locale text,
  source_path text,
  ip text,
  country text,
  asn integer,
  unsub_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz,
  email_error text,
  resent_at timestamptz,
  unsubscribed_at timestamptz,
  used_at timestamptz,
  used_order_name text,
  used_order_total numeric(12, 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS welcome_signups_email_uq ON welcome_signups (email);
CREATE UNIQUE INDEX IF NOT EXISTS welcome_signups_code_uq ON welcome_signups (upper(code));
CREATE UNIQUE INDEX IF NOT EXISTS welcome_signups_unsub_uq ON welcome_signups (unsub_token);
CREATE INDEX IF NOT EXISTS welcome_signups_ip_idx ON welcome_signups (ip, created_at);
CREATE INDEX IF NOT EXISTS welcome_signups_created_idx ON welcome_signups (created_at);
