-- 0120_assigned_zones.sql
--
-- Zone Management (owner, 2026-10-16). A zone (e.g. "Store") is assigned to
-- SPECIFIC tags by a person scanning them — per EPC, unlike bins (per product,
-- every LIVE tag follows). A zone never touches the tag's bin(s).
--
-- Not the reader zones in `zones` (Warehouse / Store / Office): those are set
-- automatically by fixed readers (items.last_seen_zone_id = where a reader last
-- heard the tag) and stay as they are. Fixed readers never change an assigned
-- zone (owner decision 4).
--
-- One zone per tag (decision 1). The zone clears automatically when the tag
-- is sold, transferred to another location, or stops being LIVE (decision 2):
-- trigger items_clear_zone_on_leave_trg, which also writes the history row.
--
-- Idempotent; lock_timeout bounds the ALTER / CREATE TRIGGER locks on items.

SET lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.assigned_zones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL REFERENCES public.locations(id),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NULL,
  archived_at  timestamptz NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assigned_zones_location_name_uq
  ON public.assigned_zones (location_id, lower(name)) WHERE archived_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.items'::regclass AND attname = 'assigned_zone_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE public.items
      ADD COLUMN assigned_zone_id uuid NULL REFERENCES public.assigned_zones(id) ON DELETE SET NULL,
      ADD COLUMN zone_assigned_at timestamptz NULL,
      ADD COLUMN zone_assigned_by uuid NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS items_assigned_zone_idx
  ON public.items (assigned_zone_id) WHERE assigned_zone_id IS NOT NULL;

CREATE OR REPLACE FUNCTION items_clear_zone_on_leave()
RETURNS trigger AS $$
DECLARE
  why  text;
  zname text;
  tid  uuid;
BEGIN
  IF OLD.assigned_zone_id IS NULL OR NEW.assigned_zone_id IS DISTINCT FROM OLD.assigned_zone_id THEN
    RETURN NEW;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    why := 'moved to another location';
  ELSIF NEW.status IS DISTINCT FROM 'in-stock' THEN
    why := CASE WHEN NEW.status = 'sold' THEN 'sold' ELSE 'no longer LIVE (' || NEW.status || ')' END;
  ELSE
    RETURN NEW;
  END IF;
  SELECT z.name, z.tenant_id INTO zname, tid FROM public.assigned_zones z WHERE z.id = OLD.assigned_zone_id;
  NEW.assigned_zone_id := NULL;
  NEW.zone_assigned_at := NULL;
  NEW.zone_assigned_by := NULL;
  IF tid IS NOT NULL THEN
    INSERT INTO public.inventory_audit_logs
      (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
    VALUES (tid, 'ADJUSTMENT', 'EPC', NEW.epc, zname, NULL, 'zone_cleared: ' || why, NULL, NULL, 'system-zone-rule');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'items_clear_zone_on_leave_trg' AND tgrelid = 'public.items'::regclass) THEN
    CREATE TRIGGER items_clear_zone_on_leave_trg
      BEFORE UPDATE OF status, location_id ON public.items
      FOR EACH ROW
      WHEN (OLD.assigned_zone_id IS NOT NULL)
      EXECUTE FUNCTION items_clear_zone_on_leave();
  END IF;
END $$;
