-- Matrix `items` is required for dashboard KPIs, locations/bin counts, and most inventory APIs.
-- When legacy 002 was skipped, `004_items_status_v26` used to run first and **fail** (ALTER on missing
-- table), blocking `004a` bins ensure. This file runs **after** `0040_ensure_bins_table.sql`.
--
-- Bootstraps `public.items` only when it is missing and `custom_skus` exists (FK target).

DO $$
BEGIN
  IF to_regclass('public.items') IS NOT NULL THEN
    RETURN;
  END IF;
  IF to_regclass('public.custom_skus') IS NULL THEN
    RAISE NOTICE 'wms: items table missing but custom_skus absent — cannot auto-create items';
    RETURN;
  END IF;

  CREATE TABLE public.items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    epc varchar(24) NOT NULL,
    serial_number bigint NOT NULL DEFAULT 0,
    custom_sku_id uuid NOT NULL REFERENCES public.custom_skus (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    bin_id uuid REFERENCES public.bins (id) ON DELETE SET NULL ON UPDATE CASCADE,
    status varchar(32) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT items_epc_unique UNIQUE (epc)
  );

  CREATE INDEX IF NOT EXISTS items_custom_sku_id_status_idx ON public.items (custom_sku_id, status);
  CREATE INDEX IF NOT EXISTS items_location_id_idx ON public.items (location_id);
  CREATE INDEX IF NOT EXISTS items_status_idx ON public.items (status);
  CREATE INDEX IF NOT EXISTS items_location_status_idx ON public.items (location_id, status);
END $$;
