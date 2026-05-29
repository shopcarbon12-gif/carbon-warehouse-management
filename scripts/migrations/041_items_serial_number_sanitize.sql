-- Sanitize items.serial_number to the Carbon-Jeans 6-digit unique policy
-- introduced 2026-05-29.
--
-- Two row-classes get rewritten:
--   A. serial_number outside [100_000, 999_999]  (wrong digit count, NULL,
--      or legacy sub-100k values). Every match gets a fresh random 6-digit
--      serial unique within its custom_sku_id.
--   B. (custom_sku_id, serial_number) duplicates. The oldest items.id
--      keeps its serial; every newer duplicate gets a fresh random
--      6-digit serial unique within its custom_sku.
--
-- IMPORTANT: this DOES NOT touch items.epc. The EPC encodes the original
-- serial and is what the physical chip broadcasts — rewriting it would
-- divorce the catalog from every tag in the warehouse. The reprint and
-- bulk-import paths (commit 2026-05-29) now derive the serial from the
-- EPC when present, falling back to items.serial_number, so a sanitized
-- row reprints to the same EPC its chip carries.
--
-- The migration is idempotent: a second run finds no rows in either set.

CREATE TEMP TABLE _sn_targets (
  id           uuid PRIMARY KEY,
  custom_sku   uuid NOT NULL,
  old_serial   bigint
) ON COMMIT DROP;

-- Class A: wrong digit count / NULL / out of band.
INSERT INTO _sn_targets (id, custom_sku, old_serial)
SELECT id, custom_sku_id, serial_number
  FROM items
 WHERE serial_number IS NULL
    OR serial_number < 100000
    OR serial_number > 999999;

-- Class B: duplicates within a custom_sku — keep the oldest items.id,
-- rewrite every newer copy. Exclude rows already targeted by Class A
-- so we don't double-process them.
INSERT INTO _sn_targets (id, custom_sku, old_serial)
SELECT i.id, i.custom_sku_id, i.serial_number
  FROM (
    SELECT id, custom_sku_id, serial_number,
           ROW_NUMBER() OVER (
             PARTITION BY custom_sku_id, serial_number
             ORDER BY created_at NULLS LAST, id
           ) AS rn
      FROM items
     WHERE serial_number BETWEEN 100000 AND 999999
  ) i
 WHERE i.rn > 1
   AND NOT EXISTS (SELECT 1 FROM _sn_targets t WHERE t.id = i.id);

-- Generate + apply unique random 6-digit serials. Loop because random()
-- can repeat; the inner SELECT confirms the candidate is free within
-- this custom_sku before committing the UPDATE. 200-attempt bail-out
-- so a stuck row can't lock the whole migration.
DO $$
DECLARE
  r        RECORD;
  cand     bigint;
  ok       boolean;
  attempt  int;
  total    int := 0;
  failed   int := 0;
BEGIN
  FOR r IN SELECT * FROM _sn_targets LOOP
    ok := false;
    FOR attempt IN 1..200 LOOP
      cand := floor(random() * 900000 + 100000)::bigint;
      IF NOT EXISTS (
        SELECT 1 FROM items
         WHERE custom_sku_id = r.custom_sku
           AND serial_number = cand
           AND id <> r.id
      ) THEN
        UPDATE items
           SET serial_number = cand
         WHERE id = r.id;
        ok := true;
        total := total + 1;
        EXIT;
      END IF;
    END LOOP;
    IF NOT ok THEN
      failed := failed + 1;
      RAISE NOTICE 'sanitize: failed to allocate serial for items.id=% (custom_sku=%)', r.id, r.custom_sku;
    END IF;
  END LOOP;
  RAISE NOTICE 'sanitize: rewrote % serial_number rows (% unresolved)', total, failed;
END $$;
