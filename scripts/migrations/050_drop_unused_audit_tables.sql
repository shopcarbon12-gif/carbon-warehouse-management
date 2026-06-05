-- 050_drop_unused_audit_tables.sql
--
-- Cleanup. The reports that shipped (Status Change, Damages, Bin Clearance) were
-- built from the EXISTING inventory_audit_logs trail, and the Putaway / Print /
-- Geiger-Locate / Item-Lookup history reports were dropped (operator decision
-- 2026-06-05). So the per-action audit tables migration 049 created were never
-- wired to anything. Drop the empty, unused tables.
--
-- KEEP: encode_events.created_by (the Re-Encode report attributes the operator
-- through it) — added in 049, still in use.

DROP TABLE IF EXISTS print_events;
DROP TABLE IF EXISTS status_changes;
DROP TABLE IF EXISTS bin_events;
DROP TABLE IF EXISTS locate_events;
DROP TABLE IF EXISTS lookup_events;
