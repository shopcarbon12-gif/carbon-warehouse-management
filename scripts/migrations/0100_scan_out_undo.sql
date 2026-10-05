-- Scan-out: an operator can undo a scan-out from the same screen. The undo is
-- an action in its own right — who reversed which tag, when, and back to what —
-- so it joins the allowed actions rather than deleting the original row.
ALTER TABLE scan_out_events DROP CONSTRAINT IF EXISTS scan_out_events_action_chk;
ALTER TABLE scan_out_events
  ADD CONSTRAINT scan_out_events_action_chk
  CHECK (action IN ('reader_start', 'reader_stop', 'scan_out', 'rejected', 'undo'));
