-- Idempotent: DBs that have public.matrices (legacy 001–003 skipped) but never ran 002 can lack `bins`.
-- **Must run before** `0041_ensure_items_matrix_table.sql` (items FK → bins) and before `0042_*` ALTER items.

CREATE TABLE IF NOT EXISTS bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  code varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bins_location_code_unique UNIQUE (location_id, code)
);
