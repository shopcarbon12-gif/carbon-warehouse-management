-- 0119_item_sibling_home.sql
--
-- One "a tag gets its product's bin" rule for every path (owner, 2026-10-16:
-- desktop and handheld bin review). Three rules existed:
--   - 0118 trigger (new rows): the LIVE tags of the same SKU at the location
--     must all share one home (primary + the same extra bins);
--   - Print Tags → Add to stock: the busiest bin of the whole product, every
--     colour;
--   - Transfer In: the busiest bin of the same size + colour.
-- The rule now lives in item_sibling_home(); the 0118 trigger, Transfer In
-- (lib/server/operations-transfers.ts) and Print Tags (which now leaves the
-- bin to the trigger) all use it.
--
-- item_sibling_home(sku, location, exclude_item) → uuid[]:
--   [1] = primary bin, [2:] = extra bins (live bins of the location only),
--   NULL when no LIVE tag of the SKU there has a live bin, or they disagree.
-- Idempotent.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION item_sibling_home(p_sku uuid, p_location uuid, p_exclude uuid DEFAULT NULL)
RETURNS uuid[] AS $$
DECLARE
  r      record;
  live   uuid[];
  homes  int := 0;
  v_bin  uuid;
  v_extra uuid[];
BEGIN
  IF p_sku IS NULL OR p_location IS NULL THEN
    RETURN NULL;
  END IF;
  -- Live bins as one array: joining bins per sibling made the planner
  -- nested-loop ~700 bins × every sibling (15–40 ms on big SKUs).
  SELECT array_agg(b.id) INTO live
    FROM public.bins b
   WHERE b.location_id = p_location
     AND b.archived_at IS NULL;
  IF live IS NULL THEN
    RETURN NULL;
  END IF;
  FOR r IN
    SELECT DISTINCT s.bin_id AS bin,
           COALESCE((SELECT array_agg(a.id ORDER BY a.id)
                       FROM unnest(s.additional_bin_ids) AS a(id)
                      WHERE a.id <> s.bin_id
                        AND a.id = ANY(live)), '{}'::uuid[]) AS extra
      FROM public.items s
     WHERE s.custom_sku_id = p_sku
       AND s.location_id = p_location
       AND s.status = 'in-stock'
       AND s.bin_id = ANY(live)
       AND (p_exclude IS NULL OR s.id <> p_exclude)
     LIMIT 2
  LOOP
    homes := homes + 1;
    v_bin := r.bin;
    v_extra := r.extra;
  END LOOP;
  IF homes <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN array_prepend(v_bin, v_extra);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION items_inherit_sibling_bin()
RETURNS trigger AS $$
DECLARE
  home uuid[];
BEGIN
  IF NEW.bin_id IS NOT NULL OR NEW.custom_sku_id IS NULL OR NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Every scan upload converges on INSERT … ON CONFLICT (epc) DO UPDATE, so
  -- this fires for tags that already exist; the conflict path never reads
  -- EXCLUDED.bin_id. One unique-index probe skips the sibling lookup.
  IF EXISTS (SELECT 1 FROM public.items x WHERE x.epc = NEW.epc) THEN
    RETURN NEW;
  END IF;
  home := item_sibling_home(NEW.custom_sku_id, NEW.location_id, NULL);
  IF home IS NOT NULL THEN
    NEW.bin_id := home[1];
    IF COALESCE(cardinality(NEW.additional_bin_ids), 0) = 0 THEN
      NEW.additional_bin_ids := COALESCE(home[2:], '{}'::uuid[]);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
