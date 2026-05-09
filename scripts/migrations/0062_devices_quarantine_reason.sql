-- 2026-05-09 — chassis-broken reader quarantine flag.
--
-- Some readers are reachable on the LAN (bridge responds to wiznet-cli
-- discovery) but the chip itself is permanently dead — chassis firmware
-- corrupt, MCU stuck in reset loop, regulator failed. Software cannot
-- turn UART break frames into valid Impinj inventory; only a
-- power-cycle / firmware reflash / chassis swap fixes the hardware.
--
-- Concrete trigger case: reader Aisle 5/2 (.82) emits the UART break
-- pattern `00 00 FF FF FF FF FF FF` every ~3 s at every baud — see
-- project_reader_82_uart_break_signature.md. The supervisor today
-- thrashes forever: silence-watchdog kicks the child every 60 s,
-- candidate-port rotation exhausts every ~5 min, exhaustion recovery
-- restarts the cycle. Operator has to remember "ignore .82" by hand.
--
-- This column lets an admin permanently mark a reader as broken-by-
-- firmware. When `quarantine_reason IS NOT NULL`:
--   - lib/server/cdm-agents.ts forces effective_paused = true on the
--     bundle so the supervisor's reconcile loop treats it as absent.
--   - lib/server/scan-sessions.ts refuses to start a session for the
--     reader (an operator hitting Start Scan on a workflow page that
--     happens to include a quarantined reader gets a clear error
--     instead of a silent no-op).
--   - components/hardware-config renders a skull icon + the reason
--     text on the reader card so ops can see the inventory of broken
--     hardware vs working hardware at a glance.
--
-- The column is plain TEXT (not enum) because the reason is mostly for
-- operator audit — "chassis firmware fault — UART break loop, see
-- project_reader_82_uart_break_signature.md" is the canonical kind of
-- value, but we want freedom for future cases (e.g. "antenna port 1
-- shorted, RMA pending"). NULL means "not quarantined" and is the
-- default for every existing reader.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quarantined_by UUID REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS devices_quarantine_reason_idx
  ON devices (id)
  WHERE quarantine_reason IS NOT NULL;
