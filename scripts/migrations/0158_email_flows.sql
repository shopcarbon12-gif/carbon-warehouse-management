-- CarbonWMS Email — Flows (phase 4, owner-approved plan 2026-11-09): automatic emails like
-- Klaviyo's flows, built from the editor's emails.
--
--   email_flows        one automation: a trigger (signup | order | abandoned_checkout | winback),
--                      its steps in order (wait / email / stop-if, JSON) and settings.
--                      status: draft (nothing happens) | live (people enter and get emails) |
--                      paused (nobody new enters; people inside wait where they are).
--   email_flow_runs    one person going through one flow: which step is next and when.
--                      trigger_key makes entering idempotent (one run per signup / order /
--                      checkout / lapse), whatever the pollers see twice.
--   email_flow_sends   every email a flow sent (or skipped), with its own code and the
--                      delivery events from SES (applyEvent, by message_id).
--   email_orders_seen  every paid order we know of (Shopify + Carbon POS), by email: the
--                      "stop if they ordered" check, win-back and the flow's sales.
--   email_flow_state   the pollers' cursors (last order / checkout / signup seen).

CREATE TABLE IF NOT EXISTS public.email_flows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'custom',   -- welcome | abandoned | thanks | winback | custom (the template it came from)
  trigger     jsonb NOT NULL,                   -- {type, ...options}
  steps       jsonb NOT NULL DEFAULT '[]',
  settings    jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused')),
  live_since  timestamptz NULL,                 -- people who did the trigger before this never enter
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_flows_tenant_idx ON public.email_flows (tenant_id, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.email_flow_runs (
  id           bigserial PRIMARY KEY,
  flow_id      uuid NOT NULL REFERENCES public.email_flows(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL,
  trigger_key  text NOT NULL,
  contact_id   bigint NULL REFERENCES public.email_contacts(id),
  email        text NOT NULL,
  first_name   text NULL,
  data         jsonb NOT NULL DEFAULT '{}',     -- {items:[…], checkoutUrl, orderName, …}
  step_index   integer NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','exited','failed')),
  exit_reason  text NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, trigger_key)
);
CREATE INDEX IF NOT EXISTS email_flow_runs_due_idx ON public.email_flow_runs (next_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS email_flow_runs_email_idx ON public.email_flow_runs (flow_id, email, started_at DESC);

CREATE TABLE IF NOT EXISTS public.email_flow_sends (
  id            bigserial PRIMARY KEY,
  run_id        bigint NOT NULL REFERENCES public.email_flow_runs(id) ON DELETE CASCADE,
  flow_id       uuid NOT NULL REFERENCES public.email_flows(id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  contact_id    bigint NULL,
  email         text NOT NULL,
  status        text NOT NULL DEFAULT 'sent',   -- sending | sent | skipped | failed
  error         text NULL,
  code          text NULL,
  discount_gid  text NULL,
  message_id    text NULL,
  sent_at       timestamptz NULL,
  delivered_at  timestamptz NULL,
  opened_at     timestamptz NULL,
  clicked_at    timestamptz NULL,
  bounced_at    timestamptz NULL,
  complained_at timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS email_flow_sends_msg_idx ON public.email_flow_sends (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_flow_sends_flow_idx ON public.email_flow_sends (flow_id, step_id);

CREATE TABLE IF NOT EXISTS public.email_orders_seen (
  source      text NOT NULL,                    -- shopify | pos
  order_id    text NOT NULL,
  tenant_id   uuid NOT NULL,
  email       text NOT NULL,
  name        text NULL,                        -- "#1084" / sale number
  total       numeric(12,2) NOT NULL DEFAULT 0,
  codes       text[] NOT NULL DEFAULT '{}',
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (source, order_id)
);
CREATE INDEX IF NOT EXISTS email_orders_seen_email_idx ON public.email_orders_seen (tenant_id, email, processed_at DESC);

CREATE TABLE IF NOT EXISTS public.email_flow_state (
  tenant_id  uuid NOT NULL,
  key        text NOT NULL,
  value      text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
