-- CarbonWMS Email AI Designer, layout engine (owner, 2026-11-08):
--  * a version is a real email layout (HTML) instead of one drawn picture:
--    store photos and product photos are the original files, only banners
--    are generated (one picture each, checked against the real products);
--  * "Show me 3 directions": three versions of one message, the owner picks one;
--  * the brand's Instagram look (style guide) from the published campaign posts.
ALTER TABLE public.email_design_messages
  ADD COLUMN IF NOT EXISTS engine        text    NOT NULL DEFAULT 'picture',  -- picture (old) | layout
  ADD COLUMN IF NOT EXISTS html          text    NULL,      -- layout: the finished email body (hosted pictures, merge tags)
  ADD COLUMN IF NOT EXISTS draft_html    text    NULL,      -- layout: the planner's HTML with {{banner:…}} / {{product:…}} slots
  ADD COLUMN IF NOT EXISTS banners       jsonb   NULL,      -- [{id, view, size, prompt, products, text, path, url, qa}]
  ADD COLUMN IF NOT EXISTS direction     text    NULL,      -- the creative direction of this version, in a few words
  ADD COLUMN IF NOT EXISTS variant_group uuid    NULL,      -- the 3 directions of one message share this
  ADD COLUMN IF NOT EXISTS variant_no    integer NULL,
  ADD COLUMN IF NOT EXISTS picked        boolean NULL;      -- the direction the owner chose

CREATE TABLE IF NOT EXISTS public.email_style_guides (
  tenant_id   uuid PRIMARY KEY,
  campaign    text NULL,
  guide       jsonb NOT NULL,
  ref_paths   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- storage paths of the most typical campaign pictures
  posts_used  integer NOT NULL DEFAULT 0,
  built_at    timestamptz NOT NULL DEFAULT now()
);

-- "Copy phone link" (owner, 2026-11-08: open a version on the phone from WhatsApp):
-- an unguessable read-only link to one version, with sample name and code.
ALTER TABLE public.email_design_messages ADD COLUMN IF NOT EXISTS share_token text NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_design_messages_share_token_uq ON public.email_design_messages (share_token) WHERE share_token IS NOT NULL;
