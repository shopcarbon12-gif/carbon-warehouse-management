-- Phone-camera hand-off sessions, persisted (2026-09-29).
--
-- The session store was a module-level Map: a deploy or restart wiped every
-- pending photo's pointer while the bytes sat in R2, and the desktop could
-- only collect while its QR panel was open. Five photos sent from a phone at
-- 06:55 ET today reached R2; the desktop collected one and stranded four.
--
-- Restore point: ~/carbon-wms-backups/studio-restore-2026-09-29/RESTORE.md §5.

CREATE TABLE IF NOT EXISTS studio_handoff_sessions (
  id              uuid PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- refreshed on every phone upload (capped at created_at + 2 h); sessions
  -- are pruned 24 h after expiry so a late recovery still finds them
  expires_at      timestamptz NOT NULL,
  -- the product the desktop opened the QR for, so uncollected photos can be
  -- recovered from that product's Studio tab after the panel is gone
  matrix_id       uuid,
  -- the desktop's last poll: the phone is told whether anyone is listening
  last_polled_at  timestamptz
);

CREATE INDEX IF NOT EXISTS studio_handoff_sessions_expires_idx
  ON studio_handoff_sessions (expires_at);
CREATE INDEX IF NOT EXISTS studio_handoff_sessions_matrix_idx
  ON studio_handoff_sessions (matrix_id, created_at DESC);

CREATE TABLE IF NOT EXISTS studio_handoff_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- arrival order; rows inserted in one transaction share now(), so this is
  -- the only key that keeps a burst in capture order
  seq         bigserial NOT NULL,
  session_id  uuid NOT NULL REFERENCES studio_handoff_sessions(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  url         text NOT NULL,
  path        text NOT NULL,
  -- when the desktop collected it; NULL = still waiting
  taken_at    timestamptz
);

CREATE INDEX IF NOT EXISTS studio_handoff_images_session_idx
  ON studio_handoff_images (session_id, seq);
