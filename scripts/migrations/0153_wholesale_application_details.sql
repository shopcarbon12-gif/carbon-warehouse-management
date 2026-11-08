-- Wholesale application details (owner 2026-11-08): before approving a
-- buyer the owner wants real business information to run a background check
-- and to issue resale paperwork — legal name, EIN, state resale permit and its
-- certificate, the full business address, and direct links to the business's
-- current social accounts (required). Older rows keep these empty.

ALTER TABLE wholesale_applications
  ADD COLUMN IF NOT EXISTS trade_name text,
  ADD COLUMN IF NOT EXISTS contact_title text,
  ADD COLUMN IF NOT EXISTS years_in_business text,
  ADD COLUMN IF NOT EXISTS ein text,
  ADD COLUMN IF NOT EXISTS resale_permit_number text,
  ADD COLUMN IF NOT EXISTS resale_permit_state text,
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS physical_store text,
  ADD COLUMN IF NOT EXISTS social_links text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS other_links text,
  ADD COLUMN IF NOT EXISTS order_size text,
  ADD COLUMN IF NOT EXISTS brands_carried text,
  ADD COLUMN IF NOT EXISTS heard_from text,
  ADD COLUMN IF NOT EXISTS agreed_terms boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS consent_verify boolean NOT NULL DEFAULT false;

-- The resale certificate the applicant uploads. Private: it carries tax IDs,
-- so it lives in the database (never the public uploads folder) and is only
-- served to signed-in admins (GET /api/shopify/wholesale/[id]/certificate).
CREATE TABLE IF NOT EXISTS wholesale_application_files (
  id bigserial PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES wholesale_applications(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'resale_certificate',
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wholesale_application_files_app_idx ON wholesale_application_files (application_id);
