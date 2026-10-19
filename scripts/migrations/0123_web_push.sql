-- Phone/computer alerts (owner 2026-10-19): a push notification for every
-- Shopify order and every Studio night-batch result, on the devices where
-- "Turn on alerts" was pressed.
--
-- web_push_config holds the server's VAPID key pair (one row, generated on
-- first use), so no environment variable has to be managed. A subscription
-- belongs to one signed-in user on one browser; `kinds` says which alerts it
-- gets. A subscription the push service reports gone (404/410) is deleted.

CREATE TABLE IF NOT EXISTS public.web_push_config (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NULL,
  user_id     uuid NULL,
  email       text NULL,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text NULL,
  kinds       text[] NOT NULL DEFAULT ARRAY['orders', 'studio'],
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz NULL,
  last_error  text NULL
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_tenant_idx ON public.web_push_subscriptions (tenant_id);
