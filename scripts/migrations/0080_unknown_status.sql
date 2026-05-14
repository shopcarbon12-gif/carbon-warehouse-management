-- Bring back the 'unknown' item status (retired by 019, now resurrected with
-- DIFFERENT flags from the old "collapses-to-tag_killed" handling).
--
-- Semantic: "we lost track of this physical tag, but it MAY still exist."
-- Unlike tag_killed (which marks a tag as physically destroyed and tells
-- handhelds to ignore it), 'unknown' keeps the tag visible to handheld
-- antennas so a future scan can recover it back to 'in-stock'.
--
-- Who writes it (after this migration ships alongside the runtime change):
--   - Cycle count reconcile: EPCs missing from BOTH the fixed-reader pass
--     AND the mobile add-on pass → unknown (not tag_killed).
--   - Count-screen override-replace wipe: tags wiped because the operator
--     said "this scan IS the truth, anything else under this SKU is gone".
--   - Operations Exceptions "mark missing" resolution.
--
-- tag_killed STAYS the right destination for genuinely dead tags: defective
-- decode-fail, re-encoded-old-EPC, super-admin destruction. Those untouched.

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;

ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
  'in-stock',
  'return',
  'damaged',
  'sold',
  'stolen',
  'tag_killed',
  'unknown',
  'pending_visibility',
  'in-transit',
  'pending_transaction'
));

-- Seed UNKNOWN into status_labels. legacy_id = 7 fills the gap in the
-- existing 1..10 sequence (1,2,3,4,5,6,8,9,10). Flags:
--   is_sellable           = false  (Web sellable: No)
--   is_visible_to_scanner = true   (Handheld processes reads — KEY difference
--                                   from tag_killed; lets a stray scan recover)
--   is_visible_in_ui      = true   (Visible in search & reporting)
--   super_admin_locked    = false  (Staff may change away per bulk rules)
--   is_system_only        = false  (Shown in staff pickers)
INSERT INTO status_labels (
  legacy_id, name, display_label,
  is_sellable, is_visible_to_scanner, is_visible_in_ui, super_admin_locked, is_system_only
) VALUES (
  7, 'UNKNOWN', 'Unknown — lost track; handheld can recover',
  false, true, true, false, false
)
ON CONFLICT (legacy_id) DO UPDATE
  SET name                  = EXCLUDED.name,
      display_label         = EXCLUDED.display_label,
      is_sellable           = EXCLUDED.is_sellable,
      is_visible_to_scanner = EXCLUDED.is_visible_to_scanner,
      is_visible_in_ui      = EXCLUDED.is_visible_in_ui,
      super_admin_locked    = EXCLUDED.super_admin_locked,
      is_system_only        = EXCLUDED.is_system_only;
