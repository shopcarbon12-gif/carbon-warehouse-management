-- CarbonWMS Email Editor (owner, 2026-11-09: "copy the layout and the email module of Klaviyo").
-- An editor email is an ordinary email design (so campaigns, test sends and translations work
-- unchanged) whose content is the editor's data (editor_doc); saving renders it into html.
--
--   email_designs.editor_doc   the email as sections → columns → blocks (lib/email-editor/types.ts)
--   email_design_versions      version history: a copy of the data when the owner leaves the
--                              editor, and at most every 10 minutes while working
--   email_uploads              pictures uploaded in the editor (served publicly for mail apps)

ALTER TABLE public.email_designs ADD COLUMN IF NOT EXISTS editor_doc jsonb NULL;

CREATE TABLE IF NOT EXISTS public.email_design_versions (
  id          bigserial PRIMARY KEY,
  design_id   uuid NOT NULL REFERENCES public.email_designs(id) ON DELETE CASCADE,
  doc         jsonb NOT NULL,
  title       text NULL,
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_design_versions_design_idx ON public.email_design_versions (design_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.email_uploads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  path        text NOT NULL,          -- storage key: email/uploads/<id>.<ext>
  url         text NOT NULL,          -- public URL mail apps load
  width       integer NULL,
  height      integer NULL,
  bytes       integer NULL,
  created_by  text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS email_uploads_tenant_idx ON public.email_uploads (tenant_id, created_at DESC);
