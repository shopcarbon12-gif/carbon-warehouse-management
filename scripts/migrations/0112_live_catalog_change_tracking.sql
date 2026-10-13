-- 0112_live_catalog_change_tracking.sql
--
-- Live catalog for the handheld (Add-On Catalog / Add-On Count, 2026-10-13).
-- The phone keeps its own copy of every EPC's status + item info and pulls a
-- tiny "what changed" delta every ~3 s while scanning. This migration lets the
-- server answer "what changed since <cursor>" exactly.
--
-- Each tracked row records the id of the transaction that last changed a
-- tracked column (live_txid). A delta returns rows written by transactions the
-- previous snapshot could not see (txid >= its xmax, or in its in-progress
-- list) — commit-order safe, unlike a plain sequence, so a long scan-finalize
-- upload can never slip behind a cursor.
--
-- Fixed readers update items.last_seen_at constantly. Those updates must NOT
-- stamp: the triggers fire only when a tracked column actually changes, which
-- also keeps last_seen_at-only updates HOT.
--
-- Re-applied on every db:migrate (tail migration): every statement here is
-- idempotent and there is deliberately no backfill. Existing rows keep
-- live_txid = 0 (fast default, no rewrite) — they are in every snapshot and
-- only enter deltas once they change.
--
-- Lock safety: ALTER TABLE / DROP TRIGGER take ACCESS EXCLUSIVE on items, which
-- fixed readers write constantly. Every DDL below is skipped once it is already
-- in place (so redeploys take no locks here), and lock_timeout bounds the first
-- run: a contested lock fails this deploy's migrate (old container keeps
-- serving; redeploy) instead of queueing all items traffic behind it.

SET lock_timeout = '10s';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['items', 'custom_skus', 'matrices', 'bins'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = ('public.' || t)::regclass AND attname = 'live_txid' AND NOT attisdropped
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN live_txid bigint NOT NULL DEFAULT 0', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['items', 'custom_skus', 'matrices', 'bins'] LOOP
    IF to_regclass('public.' || t || '_live_txid_idx') IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON public.%I (live_txid)', t || '_live_txid_idx', t);
    END IF;
  END LOOP;
END $$;

-- Deleted rows (encode-finalize / encode-rollback DELETE items; SKU merges
-- delete custom_skus). tenant_id NULL = global (custom_skus have no tenant).
CREATE TABLE IF NOT EXISTS public.live_catalog_tombstones (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NULL,
  -- 'reset' = tenant-wide "re-download everything" (RFID zero-out deletes with
  -- triggers disabled, so it writes one of these instead of per-EPC rows).
  kind        text NOT NULL CHECK (kind IN ('item', 'sku', 'reset')),
  key         text NOT NULL,                 -- items.epc | custom_skus.id::text | '*'
  live_txid   bigint NOT NULL DEFAULT txid_current(),
  deleted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_catalog_tombstones_txid_idx    ON public.live_catalog_tombstones (live_txid);
CREATE INDEX IF NOT EXISTS live_catalog_tombstones_deleted_idx ON public.live_catalog_tombstones (deleted_at);

CREATE OR REPLACE FUNCTION live_catalog_stamp_txid()
RETURNS trigger AS $$
BEGIN
  NEW.live_txid := txid_current();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- items. Trigger names start "items_zz_" on purpose: BEFORE row triggers fire
-- in name order, and these must see NEW *after* items_block_auto_revive_trg /
-- items_clear_pin_on_status_leave_in_stock_trg / items_enforce_in_stock_has_sku_trg
-- have corrected it (a WHEN clause on a BEFORE trigger sees the current NEW).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_zz_live_catalog_ins_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_zz_live_catalog_ins_trg
      BEFORE INSERT ON public.items
      FOR EACH ROW EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_zz_live_catalog_upd_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_zz_live_catalog_upd_trg
      BEFORE UPDATE OF status, custom_sku_id, bin_id, location_id, epc ON public.items
      FOR EACH ROW
      WHEN (OLD.status        IS DISTINCT FROM NEW.status
         OR OLD.custom_sku_id IS DISTINCT FROM NEW.custom_sku_id
         OR OLD.bin_id        IS DISTINCT FROM NEW.bin_id
         OR OLD.location_id   IS DISTINCT FROM NEW.location_id
         OR OLD.epc           IS DISTINCT FROM NEW.epc)
      EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION live_catalog_item_tombstone()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.live_catalog_tombstones (tenant_id, kind, key)
  VALUES ((SELECT l.tenant_id FROM public.locations l WHERE l.id = OLD.location_id), 'item', OLD.epc);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_zz_live_catalog_del_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_zz_live_catalog_del_trg
      AFTER DELETE ON public.items
      FOR EACH ROW EXECUTE FUNCTION live_catalog_item_tombstone();
  END IF;
END $$;

-- An EPC rewritten in place: the old EPC disappears for the phone.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_zz_live_catalog_epc_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_zz_live_catalog_epc_trg
      AFTER UPDATE OF epc ON public.items
      FOR EACH ROW WHEN (OLD.epc IS DISTINCT FROM NEW.epc)
      EXECUTE FUNCTION live_catalog_item_tombstone();
  END IF;
END $$;

-- custom_skus (global). Only the fields the phone shows / classifies with.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'custom_skus_zz_live_catalog_ins_trg' AND tgrelid = 'public.custom_skus'::regclass) THEN
    CREATE TRIGGER custom_skus_zz_live_catalog_ins_trg
      BEFORE INSERT ON public.custom_skus
      FOR EACH ROW EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'custom_skus_zz_live_catalog_upd_trg' AND tgrelid = 'public.custom_skus'::regclass) THEN
    CREATE TRIGGER custom_skus_zz_live_catalog_upd_trg
      BEFORE UPDATE OF ls_system_id, sku, color_code, size, retail_price, matrix_id, assigned_bin_id, archived
      ON public.custom_skus
      FOR EACH ROW
      WHEN (OLD.ls_system_id    IS DISTINCT FROM NEW.ls_system_id
         OR OLD.sku             IS DISTINCT FROM NEW.sku
         OR OLD.color_code      IS DISTINCT FROM NEW.color_code
         OR OLD.size            IS DISTINCT FROM NEW.size
         OR OLD.retail_price    IS DISTINCT FROM NEW.retail_price
         OR OLD.matrix_id       IS DISTINCT FROM NEW.matrix_id
         OR OLD.assigned_bin_id IS DISTINCT FROM NEW.assigned_bin_id
         OR OLD.archived        IS DISTINCT FROM NEW.archived)
      EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION live_catalog_sku_tombstone()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.live_catalog_tombstones (tenant_id, kind, key)
  VALUES (NULL, 'sku', OLD.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'custom_skus_zz_live_catalog_del_trg' AND tgrelid = 'public.custom_skus'::regclass) THEN
    CREATE TRIGGER custom_skus_zz_live_catalog_del_trg
      AFTER DELETE ON public.custom_skus
      FOR EACH ROW EXECUTE FUNCTION live_catalog_sku_tombstone();
  END IF;
END $$;

-- matrices: the product name shown on lines (matrices.description).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matrices_zz_live_catalog_ins_trg' AND tgrelid = 'public.matrices'::regclass) THEN
    CREATE TRIGGER matrices_zz_live_catalog_ins_trg
      BEFORE INSERT ON public.matrices
      FOR EACH ROW EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matrices_zz_live_catalog_upd_trg' AND tgrelid = 'public.matrices'::regclass) THEN
    CREATE TRIGGER matrices_zz_live_catalog_upd_trg
      BEFORE UPDATE OF description ON public.matrices
      FOR EACH ROW WHEN (OLD.description IS DISTINCT FROM NEW.description)
      EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

-- bins: code / archive / location drive the BIN line.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bins_zz_live_catalog_ins_trg' AND tgrelid = 'public.bins'::regclass) THEN
    CREATE TRIGGER bins_zz_live_catalog_ins_trg
      BEFORE INSERT ON public.bins
      FOR EACH ROW EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bins_zz_live_catalog_upd_trg' AND tgrelid = 'public.bins'::regclass) THEN
    CREATE TRIGGER bins_zz_live_catalog_upd_trg
      BEFORE UPDATE OF code, archived_at, location_id ON public.bins
      FOR EACH ROW
      WHEN (OLD.code IS DISTINCT FROM NEW.code
         OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
         OR OLD.location_id IS DISTINCT FROM NEW.location_id)
      EXECUTE FUNCTION live_catalog_stamp_txid();
  END IF;
END $$;

RESET lock_timeout;
