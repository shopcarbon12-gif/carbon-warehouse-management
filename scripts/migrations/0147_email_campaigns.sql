-- CarbonWMS Email (owner, 2026-11-07): our own email platform instead of
-- Klaviyo / Shopify Email. Lives under CarbonCast → Email.
--
--   email_settings    one row per tenant: sender, reply-to, postal address,
--                     the kill switch (sending_enabled) and the Amazon SES
--                     configuration set + SNS topic that report deliveries,
--                     opens, clicks, bounces and complaints.
--   email_contacts    every customer email we may write to: Rewards
--                     (pos_customers) + Shopify customers, cleaned. Never
--                     deleted; unsubscribed / bounced / complained are kept
--                     forever as the suppression list.
--   email_designs     AI Designer: one conversation per design. Each AI turn
--                     is a picture of the whole email (email_design_messages).
--                     "Convert to email" turns a picture into a zip package
--                     (cut-out pictures + HTML + manifest) and then into the
--                     sendable HTML stored on the design.
--   email_campaigns   one send: design + subject + audience + optional
--                     per-person Shopify code + schedule. Approved by a person.
--   email_campaign_recipients  one row per person per campaign, with their
--                     own code and every delivery event.
--   email_events      raw SES events from SNS (idempotent by SNS message id).

CREATE TABLE IF NOT EXISTS public.email_settings (
  tenant_id        uuid PRIMARY KEY,
  from_name        text NOT NULL DEFAULT 'Carbon',
  from_email       text NOT NULL DEFAULT 'vip@shopcarbon.com',
  reply_to         text NOT NULL DEFAULT 'support@shopcarbon.com',
  postal_address   text NOT NULL DEFAULT 'Carbon · 6250 Edgewater Drive, Suite 100 · Orlando, FL 32810',
  sending_enabled  boolean NOT NULL DEFAULT true,
  max_per_minute   integer NOT NULL DEFAULT 120,
  bounce_pause_pct numeric(5,2) NOT NULL DEFAULT 3.00,
  configuration_set text NOT NULL DEFAULT 'carbon-marketing',
  sns_topic_arn    text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NULL
);

CREATE TABLE IF NOT EXISTS public.email_contacts (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  email               text NOT NULL,
  first_name          text NULL,
  last_name           text NULL,
  in_rewards          boolean NOT NULL DEFAULT false,
  in_shopify          boolean NOT NULL DEFAULT false,
  shopify_customer_gid text NULL,
  shopify_marketing   text NULL,            -- SUBSCRIBED | NOT_SUBSCRIBED | UNSUBSCRIBED | …
  customer_since      date NULL,
  birthday            date NULL,
  unsub_token         text NOT NULL,
  unsubscribed_at     timestamptz NULL,
  unsubscribe_source  text NULL,            -- link | one_click | shopify | welcome | manual
  bounced_at          timestamptz NULL,
  complained_at       timestamptz NULL,
  excluded_reason     text NULL,            -- fake / staff / typo — never mailed
  last_emailed_at     timestamptz NULL,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS email_contacts_unsub_token_idx ON public.email_contacts (unsub_token);

CREATE TABLE IF NOT EXISTS public.email_designs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  title           text NOT NULL DEFAULT 'New email',
  status          text NOT NULL DEFAULT 'drafting',   -- drafting | converting | ready | failed
  chosen_message  uuid NULL,                          -- the picture that was converted
  html            text NULL,                          -- sendable template with {{merge}} tags
  subject_hint    text NULL,
  preheader_hint  text NULL,
  manifest        jsonb NULL,
  package_path    text NULL,                          -- the zip OpenAI made (R2)
  convert_error   text NULL,
  convert_started_at timestamptz NULL,
  created_by      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_designs_tenant_idx ON public.email_designs (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.email_design_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id     uuid NOT NULL REFERENCES public.email_designs(id) ON DELETE CASCADE,
  role          text NOT NULL,                 -- owner | ai
  text          text NOT NULL DEFAULT '',
  attachments   jsonb NOT NULL DEFAULT '[]',   -- [{path, name}] pictures the owner added
  target        text NOT NULL DEFAULT 'both',  -- both | desktop | mobile (which view this turn changes)
  mode          text NULL,                     -- batch | fast (ai turns)
  status        text NOT NULL DEFAULT 'done',  -- queued | planning | generating | done | failed
  desktop_prompt text NULL,
  mobile_prompt  text NULL,
  desktop_path  text NULL,                     -- desktop design picture (R2)
  mobile_path   text NULL,                     -- mobile design picture (R2)
  batch_id      text NULL,
  batch_files   jsonb NULL,
  error         text NULL,
  created_by    text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_design_messages_design_idx ON public.email_design_messages (design_id, created_at);
CREATE INDEX IF NOT EXISTS email_design_messages_open_idx ON public.email_design_messages (status) WHERE status IN ('queued','planning','generating');

CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  name            text NOT NULL,
  design_id       uuid NULL REFERENCES public.email_designs(id),
  subject         text NOT NULL DEFAULT '',
  preheader       text NOT NULL DEFAULT '',
  html            text NULL,                 -- frozen copy of the design's HTML when approved
  audience        jsonb NOT NULL DEFAULT '{}',
  offer           jsonb NULL,                -- {amount, endsAt, minSubtotal, prefix} or null
  status          text NOT NULL DEFAULT 'draft', -- draft | scheduled | sending | paused | sent | cancelled
  pause_reason    text NULL,
  send_at         timestamptz NULL,
  approved_by     text NULL,
  approved_at     timestamptz NULL,
  started_at      timestamptz NULL,
  finished_at     timestamptz NULL,
  discount_gid    text NULL,                 -- unused (one discount per person); kept for future bulk mode
  results         jsonb NULL,                -- cached code usage / sales
  results_at      timestamptz NULL,
  created_by      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_campaigns_tenant_idx ON public.email_campaigns (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.email_campaign_recipients (
  id            bigserial PRIMARY KEY,
  campaign_id   uuid NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  contact_id    bigint NOT NULL REFERENCES public.email_contacts(id),
  email         text NOT NULL,
  first_name    text NULL,
  sort_key      integer NOT NULL DEFAULT 0,  -- newest customers first
  status        text NOT NULL DEFAULT 'queued', -- queued | sending | sent | failed | skipped
  code          text NULL,
  discount_gid  text NULL,
  message_id    text NULL,                     -- SES MessageId
  error         text NULL,
  sent_at       timestamptz NULL,
  delivered_at  timestamptz NULL,
  opened_at     timestamptz NULL,
  clicked_at    timestamptz NULL,
  bounced_at    timestamptz NULL,
  complained_at timestamptz NULL,
  used_at       timestamptz NULL,
  used_order    text NULL,
  used_total    numeric(12,2) NULL,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS email_recipients_queue_idx ON public.email_campaign_recipients (campaign_id, status, sort_key, id);
CREATE INDEX IF NOT EXISTS email_recipients_message_idx ON public.email_campaign_recipients (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.email_events (
  id           text PRIMARY KEY,               -- SNS MessageId
  type         text NOT NULL,
  message_id   text NULL,
  email        text NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
