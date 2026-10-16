-- 0118_items_inherit_sibling_bin.sql
--
-- Owner decision 2026-10-16: a new tag gets its product's bin.
--
-- A bin only reached items.bin_id when someone assigned the product to a bin
-- (Shelf Map, putaway, handheld bin assign), and only for the tags LIVE at that
-- moment. A tag that entered later — first read by a count or Add-On, written by
-- an encode, or picked up on the Transfers screen — never got one, even when
-- every other tag of the product sat in the same bin (Apology Hoodie BLACK L:
-- three tags in 2F01R, the fourth, first read by count 029, with none).
--
-- Rule, on INSERT only, when the new row has no bin: look at the LIVE tags of
-- the same SKU at the same location that have a live primary bin. If they all
-- agree on one home — the same primary bin AND the same extra (multi-bin) bins —
-- the new tag gets exactly that home. Disagreement or no home → left without a
-- bin (an operator picks). A third of LIVE tags are multi-bin (primary + extra
-- bins), so the extra bins are copied too, or the new tag would be missing from
-- the extra bins' contents. Existing rows are never touched here.
--
-- One trigger covers every insert path (epc-ingress, encode-claim, commission,
-- transfers lookup, CSV ingest …). Name sorts after items_enforce_in_stock_has_sku_trg
-- and before items_zz_live_catalog_ins_trg (BEFORE row triggers fire in name order),
-- so the phone catalog's txid stamp sees the bin. Idempotent; lock_timeout bounds
-- the CREATE TRIGGER lock on the busy items table.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION items_inherit_sibling_bin()
RETURNS trigger AS $$
DECLARE
  r       record;
  live    uuid[];
  homes   int := 0;
  v_bin   uuid;
  v_extra uuid[];
BEGIN
  IF NEW.bin_id IS NOT NULL OR NEW.custom_sku_id IS NULL OR NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Every scan upload converges on INSERT … ON CONFLICT (epc) DO UPDATE
  -- (epc-ingress, cycle-count scan), so this fires for tags that already exist;
  -- the conflict path never reads EXCLUDED.bin_id. One unique-index probe skips
  -- the sibling lookup for them.
  IF EXISTS (SELECT 1 FROM public.items x WHERE x.epc = NEW.epc) THEN
    RETURN NEW;
  END IF;
  -- Live bins of the location as one array: joining bins per sibling made the
  -- planner nested-loop ~700 bins × every sibling (15–40 ms on big SKUs); this
  -- keeps the worst SKU in prod (528 LIVE tags) at ~1–4 ms.
  SELECT array_agg(b.id) INTO live
    FROM public.bins b
   WHERE b.location_id = NEW.location_id
     AND b.archived_at IS NULL;
  IF live IS NULL THEN
    RETURN NEW;
  END IF;
  FOR r IN
    SELECT DISTINCT s.bin_id AS bin,
           COALESCE((SELECT array_agg(a.id ORDER BY a.id)
                       FROM unnest(s.additional_bin_ids) AS a(id)
                      WHERE a.id <> s.bin_id
                        AND a.id = ANY(live)), '{}'::uuid[]) AS extra
      FROM public.items s
     WHERE s.custom_sku_id = NEW.custom_sku_id
       AND s.location_id = NEW.location_id
       AND s.status = 'in-stock'
       AND s.bin_id = ANY(live)
     LIMIT 2
  LOOP
    homes := homes + 1;
    v_bin := r.bin;
    v_extra := r.extra;
  END LOOP;
  IF homes = 1 THEN
    NEW.bin_id := v_bin;
    IF COALESCE(cardinality(NEW.additional_bin_ids), 0) = 0 THEN
      NEW.additional_bin_ids := v_extra;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_inherit_sibling_bin_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_inherit_sibling_bin_trg
      BEFORE INSERT ON public.items
      FOR EACH ROW EXECUTE FUNCTION items_inherit_sibling_bin();
  END IF;
END $$;
