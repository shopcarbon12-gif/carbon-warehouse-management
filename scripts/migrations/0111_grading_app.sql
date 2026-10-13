-- CarbonGradingAI (the phone app that measures a garment from one photo with the
-- depth sensor), 2026-10-13. Plan v3: artifact U8mhLmEQvrP31ErvyWnHgG.
--
-- Cut groups: products that share a pattern. The owner builds them by hand
-- (never proposed from supplier POs). One garment measured per cut and size
-- covers every product and colour in the cut, so a measurement saved from the
-- app is written to every member's SKU of that size.
CREATE TABLE IF NOT EXISTS size_grading_cut_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- grading-app profile id (tee, trousers, ...); null = each product's own
  profile     text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A product is in at most one cut: two cuts claiming one product would make
-- "which measurement is right" a coin toss.
CREATE TABLE IF NOT EXISTS size_grading_cut_group_members (
  cut_group_id uuid NOT NULL REFERENCES size_grading_cut_groups(id) ON DELETE CASCADE,
  matrix_id    uuid NOT NULL UNIQUE REFERENCES matrices(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (cut_group_id, matrix_id)
);

-- One row per photo saved from the app. It keeps everything needed to judge a
-- reading later and to train the app's own point-finding model: the squared-up
-- photo (R2 + a copy in the owner's Dropbox), every line as the operator left
-- it, where each line came from (outline / AI / moved by hand), what the AI and
-- the outline proposed, and the depth reading that set the scale.
CREATE TABLE IF NOT EXISTS size_grading_scans (
  id             uuid PRIMARY KEY,
  custom_sku_id  uuid NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  matrix_id      uuid NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
  cut_group_id   uuid REFERENCES size_grading_cut_groups(id) ON DELETE SET NULL,
  profile        text NOT NULL,
  garment_type   text NOT NULL,
  view           text NOT NULL DEFAULT 'front',
  size           text,
  -- { "chest": 52.1, "sleeveL": 20.3, "sleeve": 20.2, ... } as saved
  points_cm      jsonb NOT NULL,
  -- { key: { "pts": [[x,y],[x,y]] , "source": "outline"|"ai"|"manual", "moved": bool } } in photo pixels
  lines          jsonb NOT NULL,
  ai_lines       jsonb,
  outline_lines  jsonb,
  px_per_cm      numeric(10, 4) NOT NULL,
  photo_w        integer,
  photo_h        integer,
  photo_key      text,
  dropbox_path   text,
  dropbox_error  text,
  -- distance, tilt, garment height, plane fit, calibration factor, ToF or not
  depth          jsonb,
  device         jsonb,
  app_version    text,
  ai_model       text,
  ai_cost_usd    numeric(10, 5),
  -- saved | flagged | approved | redo
  status         text NOT NULL DEFAULT 'saved',
  flags          jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_to     integer NOT NULL DEFAULT 0,
  review_note    text,
  reviewed_at    timestamptz,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  captured_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS size_grading_scans_created_idx ON size_grading_scans (created_at DESC);
CREATE INDEX IF NOT EXISTS size_grading_scans_status_idx ON size_grading_scans (status, created_at DESC);
CREATE INDEX IF NOT EXISTS size_grading_scans_matrix_idx ON size_grading_scans (matrix_id, size);

-- Which reading came from where. A web reading has no scan; an app reading
-- points at its scan, so "redo" on the review screen can take back exactly the
-- rows that scan wrote.
ALTER TABLE size_grading_measurements ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';
ALTER TABLE size_grading_measurements ADD COLUMN IF NOT EXISTS scan_id uuid REFERENCES size_grading_scans(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS size_grading_measurements_scan_idx ON size_grading_measurements (scan_id) WHERE scan_id IS NOT NULL;

-- CarbonGradingAI APK releases (separate from the handheld's app_releases: a
-- different app, package and signing key). The newest row is offered as the update.
CREATE TABLE IF NOT EXISTS grading_app_releases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     text NOT NULL,
  apk_url     text NOT NULL,
  sha1        text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
