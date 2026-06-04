-- 2026-06-04 — Per-EPC child table for Add-On Count sessions.
--
-- WHY: the old design stored every scanned EPC in a single JSONB blob
-- (add_on_sessions.epc_ledger) and rewrote the WHOLE blob on every single
-- /epc POST via `epc_ledger = epc_ledger || jsonb_build_object(...)`. That is
-- O(n) per insert → O(n²) for the session; once the ledger reached ~1.5 MB
-- (~13–15k EPCs) each write rewrote the whole multi-MB value (TOAST + a new
-- row version every time), the per-EPC POSTs backed up, and scanning appeared
-- to "stop". This child table makes each insert O(1) via ON CONFLICT DO
-- NOTHING on a real unique key.
--
-- The epc_ledger / failed_ledger JSONB columns on add_on_sessions are KEPT for
-- back-compat but are no longer written per-EPC. getSession reconstructs the
-- maps from this table (for resume/hydration), and finalize reads the EPC set
-- from here too.
CREATE TABLE IF NOT EXISTS add_on_session_epcs (
  session_id  UUID NOT NULL REFERENCES add_on_sessions(id) ON DELETE CASCADE,
  epc         TEXT NOT NULL,
  -- false = valid "new" count; true = failed-validation (hidden during scan,
  -- surfaced as the Defective sheet on finalize).
  failed      BOOLEAN NOT NULL DEFAULT false,
  reason      TEXT,
  u           UUID,
  d           TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, epc)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS add_on_session_epcs_session_failed_idx
  ON add_on_session_epcs (session_id, failed);
--> statement-breakpoint
-- Backfill any existing JSONB ledgers into the child table so in-flight /
-- historical sessions keep their EPCs after the cutover. Idempotent.
INSERT INTO add_on_session_epcs (session_id, epc, failed, reason, u, d, at)
SELECT s.id, x.key, false, NULL,
       NULLIF(x.val->>'u', '')::uuid, x.val->>'d',
       COALESCE((x.val->>'at')::timestamptz, now())
  FROM add_on_sessions s, jsonb_each(s.epc_ledger) AS x(key, val)
 WHERE jsonb_typeof(s.epc_ledger) = 'object'
ON CONFLICT (session_id, epc) DO NOTHING;
--> statement-breakpoint
INSERT INTO add_on_session_epcs (session_id, epc, failed, reason, u, d, at)
SELECT s.id, x.key, true, x.val->>'r',
       NULLIF(x.val->>'u', '')::uuid, x.val->>'d',
       COALESCE((x.val->>'at')::timestamptz, now())
  FROM add_on_sessions s, jsonb_each(s.failed_ledger) AS x(key, val)
 WHERE jsonb_typeof(s.failed_ledger) = 'object'
ON CONFLICT (session_id, epc) DO NOTHING;
