-- Model profiles (owner, 2026-10-11): the people in CARBON's product photos —
-- the AI Studio models (linked to models.name) and the real photo-shoot models —
-- with their measurements, so each product can say "Model is 5'8\" and wears size S".
-- Heights marked height_source='owner' were given by the owner; the rest, and all
-- body measurements, are estimates from the photos (scaled to the owner's heights).
CREATE TABLE IF NOT EXISTS model_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,           -- W1…, M1…
  label          text NOT NULL,                  -- "Latina", "auburn hair"
  kind           text NOT NULL CHECK (kind IN ('ai','real')),
  studio_model_name text,                        -- models.name for AI Studio models
  gender         text NOT NULL CHECK (gender IN ('female','male')),
  height         text NOT NULL,                  -- 5'8"
  height_cm      int  NOT NULL,
  bust_or_chest_in numeric(4,1),
  waist_in       numeric(4,1),
  hips_in        numeric(4,1),
  size           text,                           -- usual size worn
  jeans_waist    text,
  height_source  text NOT NULL DEFAULT 'estimate',
  photos_being_replaced boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS model_profiles_studio_name_uq ON model_profiles (lower(studio_model_name)) WHERE studio_model_name IS NOT NULL;

INSERT INTO model_profiles (code,label,kind,studio_model_name,gender,height,height_cm,bust_or_chest_in,waist_in,hips_in,size,jeans_waist,height_source,photos_being_replaced) VALUES
  ('W1', 'Latina', 'ai', 'Latina', 'female', '5''8"', 173, '33.5', '25.5', '36.5', 'S', '26', 'owner', FALSE),
  ('W2', 'Gringa', 'ai', 'Gringa', 'female', '5''8"', 173, '32', '24', '35', 'XS–S', '25', 'estimate', FALSE),
  ('W3', 'Afro', 'ai', 'Afro', 'female', '5''7"', 170, '33', '25', '36', 'S', '26', 'estimate', FALSE),
  ('W4', 'auburn hair', 'real', NULL, 'female', '5''7"', 170, '32', '25', '35', 'S', '26', 'estimate', FALSE),
  ('W5', 'big afro, light eyes', 'real', NULL, 'female', '5''7"', 170, '32.5', '24.5', '35.5', 'XS–S', '25', 'owner', FALSE),
  ('W6', 'curly brown hair', 'real', NULL, 'female', '5''8"', 173, '34', '25.5', '36', 'S', '26', 'owner', TRUE),
  ('W7', 'long dark hair', 'real', NULL, 'female', '5''7"', 170, '35', '27', '38', 'M', '27', 'owner', TRUE),
  ('W8', 'light brown hair', 'real', NULL, 'female', '5''8"', 173, '33.5', '25.5', '36.5', 'S', '26', 'owner', TRUE),
  ('M1', 'Gringo', 'ai', 'Gringo', 'male', '6''1"', 185, '40', '32', NULL, 'M', '32', 'estimate', FALSE),
  ('M2', 'Rico', 'ai', 'Rico', 'male', '6''1"', 185, '41', '32', NULL, 'M', '32', 'estimate', FALSE),
  ('M3', 'dark curly hair', 'real', NULL, 'male', '6''1"', 185, '39', '31', NULL, 'M', '31', 'owner', FALSE),
  ('M4', 'curly fade, earrings', 'real', NULL, 'male', '6''0"', 183, '37', '29', NULL, 'S', '29–30', 'estimate', FALSE),
  ('M5', 'man bun, tattoos', 'real', NULL, 'male', '6''1"', 185, '41.5', '32', NULL, 'M', '32', 'owner', FALSE),
  ('M6', 'dark hair, stubble', 'real', NULL, 'male', '6''0"', 183, '39', '31', NULL, 'M', '31', 'estimate', FALSE),
  ('M7', 'light brown hair, beard', 'real', NULL, 'male', '6''1"', 185, '40', '32', NULL, 'M', '32', 'estimate', FALSE),
  ('M8', 'dark hair', 'real', NULL, 'male', '5''11"', 180, '37.5', '29.5', NULL, 'S', '30', 'owner', FALSE),
  ('M9', 'wavy dark hair', 'real', NULL, 'male', '6''0"', 183, '39', '31', NULL, 'M', '31', 'estimate', FALSE),
  ('M10', 'short hair, goatee', 'real', NULL, 'male', '6''1"', 185, '40.5', '32.5', NULL, 'M', '33', 'owner', FALSE),
  ('M11', 'braids, beard', 'real', NULL, 'male', '5''9"', 175, '37.5', '29.5', NULL, 'S', '30', 'owner', TRUE),
  ('M12', 'big curly hair', 'real', NULL, 'male', '5''9"', 175, '35.5', '28.5', NULL, 'S', '29', 'owner', TRUE),
  ('M13', 'short dark hair', 'real', NULL, 'male', '5''11"', 180, '38', '30', NULL, 'S–M', '30', 'owner', TRUE),
  ('M14', 'Victor', 'ai', 'Victor', 'male', '6''1"', 185, '40', '32', NULL, 'M', '32', 'estimate', FALSE)
ON CONFLICT (code) DO NOTHING;

-- The model in a product's photos, and the line shown for it ("Model is 5'8\" and
-- wears size S"). model_size_worn starts as the model's usual size and is refined
-- once the item's own measurements exist.
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS model_profile_id uuid REFERENCES model_profiles(id) ON DELETE SET NULL;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS model_size_worn text;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS model_line text;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS model_source text;
