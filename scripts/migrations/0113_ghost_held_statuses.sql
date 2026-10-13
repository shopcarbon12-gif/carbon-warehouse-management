-- 0113_ghost_held_statuses.sql
--
-- Owner decision 2026-10-13 (Statuses page): Ghost — scanners ignore the read
-- (no beep, no count, no status change) — now also applies to RETURN, DAMAGED,
-- SOLD, IN TRANSIT and PENDING TRANSACTION, alongside STOLEN, TAG KILLED and
-- PENDING VISIBILITY. Ghost is stored as is_visible_to_scanner = false and is
-- honoured by every scan path (handheld app, desktop cycle count, fixed
-- readers, Count / Add-On uploads) but not by workflows: transfer receive,
-- scan-out, returns, encode and manual status changes keep working.
--
-- Production applies each migration once (scripts/docker-migrate.mjs ledger);
-- after that only a Super Admin changes the flag, from the Statuses page.

UPDATE public.status_labels
   SET is_visible_to_scanner = false,
       updated_at = now()
 WHERE upper(trim(name)) IN ('RETURN', 'DAMAGED', 'SOLD', 'IN TRANSIT', 'PENDING TRANSACTION')
   AND is_visible_to_scanner = true;
