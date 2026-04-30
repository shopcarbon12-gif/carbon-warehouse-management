-- v3.4: Manual antenna connection test.
-- Operator clicks "TEST" next to an antenna in Hardware Config; WMS sets
-- `test_pending_at` on the device row. The next time the agent polls config
-- it sees the flag, runs a 30-second listen window on the parent reader's
-- stream, and POSTs back whether ANY EPC bytes came through during the
-- window. WMS updates the antenna's status_online from that result.
--
-- Caveat: the test listens to the parent reader's binary stream, so it
-- can't currently distinguish which physical antenna port produced a tag.
-- If a reader has 2 antennas configured and only one is physically wired,
-- both will report ONLINE during a test. Documented in UI; per-antenna
-- isolation requires reverse-engineering more of the binary protocol.

--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS test_pending_at  TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_at      TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_passed  BOOLEAN;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_epc_count INT;

--> statement-breakpoint
-- Index for the agent's "what tests are pending" query — partial index
-- only over rows with a pending test, which is almost always 0 rows.
CREATE INDEX IF NOT EXISTS devices_test_pending_idx
  ON devices (test_pending_at)
  WHERE test_pending_at IS NOT NULL;
