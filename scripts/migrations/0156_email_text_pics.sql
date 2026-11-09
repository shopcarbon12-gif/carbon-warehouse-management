-- CarbonWMS Email Editor — "Send as a picture" headlines (owner, 2026-11-09: the exact font in
-- every inbox, Gmail and Outlook included). A text block drawn once in a headless Chromium at 2×;
-- the key is a hash of everything that shapes it (words, styles, fonts, width, colour behind), so
-- the same headline in two emails is one picture. Translated copies (es/pt) get their own keys.
--
--   key         16 hex characters (lib/email-editor/render.ts hashKey)
--   url         served by /api/public/email-media/uploads/pic-<key>.png

CREATE TABLE IF NOT EXISTS public.email_text_pics (
  key         text PRIMARY KEY,
  url         text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  bytes       integer NOT NULL,
  alt         text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
