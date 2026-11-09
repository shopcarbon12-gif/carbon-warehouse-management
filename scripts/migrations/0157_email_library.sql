-- CarbonWMS Email Editor, phase 2 (owner, 2026-11-09: Klaviyo's templates, saved blocks and brand kit).
--
--   email_saved       the store's own templates (a whole email) and saved sections (one section,
--                     reused in any email as a copy). kind = 'template' | 'section'.
--   email_brand_kit   one per store: the email styles (fonts, colours, buttons, page) new blank
--                     emails start with, plus the brand colours shown in every colour picker.

CREATE TABLE IF NOT EXISTS public.email_saved (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('template', 'section')),
  name         text NOT NULL,
  data         jsonb NOT NULL,
  created_by   text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_saved_tenant_idx ON public.email_saved (tenant_id, kind, created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.email_brand_kit (
  tenant_id    uuid PRIMARY KEY,
  kit          jsonb NOT NULL,
  updated_by   text NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
