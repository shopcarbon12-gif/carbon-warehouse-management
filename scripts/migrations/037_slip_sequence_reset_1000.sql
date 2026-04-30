-- Restart the slip-number sequence at 1000 (was 70000 from migration 036).
-- ALTER SEQUENCE IF EXISTS is PG 9.5+. Idempotent — re-running keeps the
-- sequence pinned to 1000 only if no slip has been issued yet; once a slip
-- has been pulled the sequence is past it and RESTART is a no-op for
-- subsequent runs (we don't want to reset over live slip numbers).

DO $$
DECLARE
  current_max BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.sequences
    WHERE sequence_schema = current_schema()
      AND sequence_name = 'transfer_records_slip_number_seq'
  ) THEN
    SELECT COALESCE(MAX(slip_number), 0) INTO current_max FROM transfer_records;
    IF current_max < 1000 THEN
      EXECUTE 'ALTER SEQUENCE transfer_records_slip_number_seq RESTART WITH 1000';
      EXECUTE 'ALTER SEQUENCE transfer_records_slip_number_seq MINVALUE 1';
    END IF;
  END IF;
END
$$;
