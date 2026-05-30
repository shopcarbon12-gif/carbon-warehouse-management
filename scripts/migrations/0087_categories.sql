-- Categories admin: a real parent→subcategory tree, WMS-owned and independent
-- of items. Backs the /inventory/categories "Legacy" manager popup.
--
-- Until now "categories" existed only as free-text matrices.category /
-- matrices.subcategory_1 values pulled read-only from Lightspeed; there was no
-- place to create/rename/delete a category (and no way to have an EMPTY one).
-- This table gives the operator that, without touching items or the POS.
--
-- Two levels only, matching the Lightspeed manager: parent_id IS NULL = a
-- top-level (parent) category; parent_id set = a subcategory of that parent.

CREATE TABLE IF NOT EXISTS public.categories (
  id          uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id   uuid         NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  name        varchar(128) NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness, split by scope: one parent name per tenant, and
-- one subcategory name per parent. Partial indexes act as the ON CONFLICT
-- arbiters for the seed + the API inserts.
CREATE UNIQUE INDEX IF NOT EXISTS categories_parent_name_uniq
  ON public.categories (tenant_id, lower(name))
  WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_sub_name_uniq
  ON public.categories (parent_id, lower(name))
  WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS categories_tenant_parent_idx
  ON public.categories (tenant_id, parent_id);

-- One-shot seed from the categories already on items, so the manager mirrors
-- today's catalog on first open. Guarded on an empty table so re-running this
-- migration on later deploys never resurrects operator-deleted categories.
-- (matrices has no tenant_id — it's global — so we attach the seeded tree to
-- every tenant via the CROSS JOIN; today that's exactly one tenant.)
DO $seed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.categories) THEN
    INSERT INTO public.categories (tenant_id, name)
    SELECT t.id, c.name
    FROM tenants t
    CROSS JOIN (
      SELECT DISTINCT trim(category) AS name
      FROM matrices
      WHERE category IS NOT NULL AND trim(category) <> ''
    ) c
    ON CONFLICT DO NOTHING;

    INSERT INTO public.categories (tenant_id, parent_id, name)
    SELECT p.tenant_id, p.id, s.name
    FROM (
      SELECT DISTINCT trim(category) AS parent, trim(subcategory_1) AS name
      FROM matrices
      WHERE category IS NOT NULL AND trim(category) <> ''
        AND subcategory_1 IS NOT NULL AND trim(subcategory_1) <> ''
    ) s
    JOIN public.categories p
      ON p.parent_id IS NULL AND lower(p.name) = lower(s.parent)
    ON CONFLICT DO NOTHING;
  END IF;
END
$seed$;
