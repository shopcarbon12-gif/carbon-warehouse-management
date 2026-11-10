-- CarbonWMS Email — phase 5 (owner-approved plan 2026-11-09): segments, A/B subject tests.
--
--   email_segments    saved audiences ("bought 2+ times in a year", "opened in the last 30 days",
--                     "Rewards members with a birthday this month" …): rules jsonb, all must match.
--                     A campaign copies the rules when it is approved (the list is frozen then).
--   email_campaigns.ab  {subjectB, preheaderB, testPct, hours, metric, testDoneAt?, winner?}:
--                     test group gets A or B, the rest waits for the winner.
--   email_campaign_recipients.variant  A | B (test group) | W (waits for the winner) | NULL (no test).

CREATE TABLE IF NOT EXISTS public.email_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  rules       jsonb NOT NULL DEFAULT '[]',
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_segments_tenant_idx ON public.email_segments (tenant_id) WHERE archived_at IS NULL;

ALTER TABLE public.email_campaigns ADD COLUMN IF NOT EXISTS ab jsonb NULL;
ALTER TABLE public.email_campaign_recipients ADD COLUMN IF NOT EXISTS variant text NULL;
CREATE INDEX IF NOT EXISTS email_campaign_recipients_variant_idx ON public.email_campaign_recipients (campaign_id, variant, status);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_email_idx ON public.email_campaign_recipients (email);
CREATE INDEX IF NOT EXISTS email_flow_sends_email_idx ON public.email_flow_sends (email);
