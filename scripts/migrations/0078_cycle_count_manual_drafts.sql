-- Cycle count side-table for manual (non-RFID) item counts.
--
-- The existing cycle count flow is purely RFID — the operator scans EPCs on a
-- handheld and the session commit applies matched/missing/misplaced math to
-- the items table. Manual SKUs (matrices.is_manual_only = TRUE) have no EPCs,
-- so they can't ride that flow.
--
-- Instead, the cycle count workspace's new "Manual Items" popup writes to
-- this table — one draft row per (session, custom_sku_id). The popup has two
-- actions:
--   Save     → upsert with state='draft' (operator can come back and edit).
--   Finish   → for each row with count_qty NOT NULL, immediately apply the
--              override via applyManualItemOverride() (writes manual_item_qty
--              + history row, source='cycle_count'), then set state='committed'
--              + committed_at = now(). The cycle count session itself is
--              decoupled: manual entries commit independently.
--
-- expected_qty_at_save snapshots the catalog qty at the moment the operator
-- first opened the popup — so the +N/-N delta badge in the UI stays stable
-- even if LS sync runs in another tab while the operator is counting.

CREATE TABLE IF NOT EXISTS cycle_count_manual_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES cycle_count_sessions(id) ON DELETE CASCADE,
  custom_sku_id UUID NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  expected_qty_at_save INTEGER NOT NULL,
  count_qty INTEGER,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'committed')),
  saved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  history_id UUID REFERENCES manual_item_qty_history(id) ON DELETE SET NULL,
  UNIQUE (session_id, custom_sku_id)
);

CREATE INDEX IF NOT EXISTS cycle_count_manual_drafts_session_idx
  ON cycle_count_manual_drafts (session_id);
