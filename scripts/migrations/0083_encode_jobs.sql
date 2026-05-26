-- 0083_encode_jobs.sql
-- Queue table for "actually program the chip" requests from the Encode
-- Items page. WMS writes a 'pending' row when the operator clicks
-- Encode; the carbon-cdm agent polls, runs `MonsoonReader --target_tag
-- <old> --write_tag <new>` against the chosen fixed reader, then POSTs
-- the result back. The UI polls the row to flip the status cell from
-- "Writing…" to "Wrote ✓" / "Write failed: <reason>".

CREATE TABLE IF NOT EXISTS public.encode_jobs (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Which fixed reader should do the write. Required — the agent looks
  -- up the bridge IP/port from this device row.
  reader_id       uuid        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Which user kicked the job (audit trail). NULL when the request
  -- came from a non-session caller (currently none, but future-proof).
  requested_by    uuid        NULL,
  -- The EPC currently on the chip — used as MonsoonReader --target_tag.
  old_epc         text        NOT NULL,
  -- The EPC we want on the chip — used as MonsoonReader --write_tag.
  -- This is the same value already inserted into items by encode-claim;
  -- duplicating it here makes the agent's job self-contained.
  new_epc         text        NOT NULL,
  -- The new EPC's owning custom_sku, for audit only (encode_events
  -- already has this; we keep a denormalized copy so the queue table
  -- is queryable without a join).
  custom_sku_id   uuid        NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  -- Lifecycle. pending → running (agent picked it up) → done | failed.
  status          text        NOT NULL DEFAULT 'pending',
  -- Number of times the agent has attempted this write. Increment on
  -- every claim. A future retry policy can bound this; today the UI
  -- requests one attempt and surfaces failures back to the operator.
  attempts        int         NOT NULL DEFAULT 0,
  -- Human-readable failure detail when status='failed'.
  error_msg       text        NULL,
  -- Free-form payload the agent can attach to a result (stderr last
  -- line, MonsoonReader exit code, etc.). Stored as jsonb for cheap
  -- queries later.
  result_meta     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz NULL,
  finished_at     timestamptz NULL,
  CONSTRAINT encode_jobs_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed'))
);

-- Partial index keeps the agent's "give me pending jobs for my readers"
-- query cheap as the table grows. Cleanup of done/failed rows is on a
-- separate cadence; this index size is bounded by concurrent work.
CREATE INDEX IF NOT EXISTS encode_jobs_pending_idx
  ON public.encode_jobs (tenant_id, reader_id, created_at)
  WHERE status = 'pending';

-- For the UI's status poll: GET /api/rfid/encode-jobs/[id] hits id (PK)
-- directly. No extra index needed there.
