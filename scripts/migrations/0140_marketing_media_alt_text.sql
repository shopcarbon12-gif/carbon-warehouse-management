-- Social: alt text for every feed picture, written automatically with the shared
-- alt-text rules (lib/seo/alt-text.ts) and sent to Instagram with the post
-- (owner, 2026-10-26: "add it all auto always").
ALTER TABLE public.marketing_post_media ADD COLUMN IF NOT EXISTS alt_text text NULL;
