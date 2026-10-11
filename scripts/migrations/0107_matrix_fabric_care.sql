-- Product details block (owner, 2026-10-11): fabric composition and care for
-- each matrix, shown in Matrix → Matrix tab under Shared Values and later
-- published to the product's details block on Shopify.
--   fabric_composition — exactly as the supplier sheet states it,
--                        e.g. "97% COTTON 3% ELASTANE".
--   fabric_source      — where it came from (the Dropbox ORDERS import sheet,
--                        or "manual"), so a value can always be traced.
--   care_instructions  — decided by the owner; empty until then.
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS fabric_composition text;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS fabric_source text;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS care_instructions text;
