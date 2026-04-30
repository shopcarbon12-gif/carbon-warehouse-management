-- Sequential slip number for outbound transfers. Operators reference these on
-- the floor and on PDF packing slips (Senitron parity — slip numbers start at
-- 70000 in the legacy system; we continue from there so paper records line up).
--
-- Implementation: BIGINT column + BIGSERIAL-like sequence (independent of the
-- transfer_records primary key UUID). Auto-assigned on insert when not given.

ALTER TABLE transfer_records
  ADD COLUMN IF NOT EXISTS slip_number BIGINT;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS transfer_records_slip_number_seq
  START WITH 1000
  MINVALUE 1;
--> statement-breakpoint
-- Default future inserts to nextval. Existing rows stay NULL until manually
-- backfilled (no slip# was ever shown to operators for them).
ALTER TABLE transfer_records
  ALTER COLUMN slip_number SET DEFAULT nextval('transfer_records_slip_number_seq');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS transfer_records_slip_number_unique_idx
  ON transfer_records (slip_number)
  WHERE slip_number IS NOT NULL;
