-- Cleanup for the categories seed (migration 0087).
--
-- matrices.category mixes clean parents ("MEN") with Lightspeed full-path
-- strings ("MEN >> ACCESSORIES"). The 0087 seed turned every distinct
-- category string into a top-level category, so the path strings became bogus
-- top-level rows that duplicate the real subcategories already nested under
-- MEN / WOMEN (seeded from matrices.subcategory_1).
--
-- This migration folds each "PARENT >> SUB" top-level row back under its real
-- parent: if SUB already exists under PARENT it's an exact duplicate and is
-- deleted; otherwise the row is reparented + renamed into a proper
-- subcategory (so unique ones like "MEN >> SHIRT" are preserved, not lost).
--
-- Idempotent: after one run no top-level name contains ">>", so re-applying on
-- later deploys is a no-op. Leaves only GENERAL / MEN / UNISEX / WOMEN (and any
-- other genuinely-top-level category) at the root.

DO $cleanup$
DECLARE
  r           RECORD;
  v_parent    text;
  v_sub       text;
  v_parent_id uuid;
  v_existing  uuid;
BEGIN
  FOR r IN
    SELECT id, tenant_id, name
    FROM categories
    WHERE parent_id IS NULL AND position('>>' IN name) > 0
  LOOP
    v_parent := btrim(split_part(r.name, '>>', 1));
    v_sub    := btrim(substring(r.name FROM position('>>' IN r.name) + 2));

    IF v_sub = '' THEN
      CONTINUE; -- malformed "X >>" with no sub; leave it alone
    END IF;

    -- Resolve (or create) the real top-level parent, e.g. MEN.
    SELECT id INTO v_parent_id
    FROM categories
    WHERE tenant_id = r.tenant_id AND parent_id IS NULL AND lower(name) = lower(v_parent)
    LIMIT 1;

    IF v_parent_id IS NULL THEN
      INSERT INTO categories (tenant_id, name)
      VALUES (r.tenant_id, v_parent)
      RETURNING id INTO v_parent_id;
    END IF;

    -- Already present under that parent? Then this row is a pure duplicate.
    SELECT id INTO v_existing
    FROM categories
    WHERE parent_id = v_parent_id AND lower(name) = lower(v_sub)
    LIMIT 1;

    IF v_existing IS NULL THEN
      UPDATE categories
      SET name = v_sub, parent_id = v_parent_id, updated_at = now()
      WHERE id = r.id;
    ELSE
      DELETE FROM categories WHERE id = r.id;
    END IF;
  END LOOP;
END
$cleanup$;
