-- Adds first_name + last_name to the shared `users` table.
--
-- Why on `users` and not on `pos_employees` / `rewards_employees`:
--   The user identity (email, password) is shared across WMS/POS/Rewards
--   already via `users` + per-app role rows. First+last name is identity-
--   level data, not per-app — a cashier who also has rewards access has
--   one name, not three. Putting the columns on the shared row keeps the
--   three Settings → Users panels in sync without per-app columns drifting.
--
-- Both columns are nullable so the migration is safe on existing rows;
-- the Settings UIs will surface empty names as "—" until an admin edits
-- the row.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name  text;

-- Trim/normalize helper for any future inserts. Empty strings → NULL so
-- the UI's "name missing" detection is a simple IS NULL check instead of
-- "IS NULL OR trim() = ''" in three different places.
ALTER TABLE users
  ALTER COLUMN first_name SET DEFAULT NULL,
  ALTER COLUMN last_name  SET DEFAULT NULL;
