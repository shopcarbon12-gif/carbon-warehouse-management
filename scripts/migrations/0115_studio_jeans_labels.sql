-- Jeans / denim-shorts back-waistband label library (owner, 2026-10-14).
--
-- The generator kept drawing a different leather patch in Pose 4 and Pose 7.
-- The owner uploads photos of the real labels once (stored on R2 like the
-- model references), picks one per product in the Studio when the item type is
-- JEANS / DENIM SHORTS, and the panels with Pose 4 and Pose 7 attach that photo
-- so the patch is copied instead of invented. Idempotent.
CREATE TABLE IF NOT EXISTS studio_jeans_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL DEFAULT '',
  image_url   text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS studio_jeans_labels_tenant_idx
  ON studio_jeans_labels (tenant_id, created_at DESC)
  WHERE archived_at IS NULL;

-- The label chosen for a product (NULL = none).
ALTER TABLE studio_matrix_state
  ADD COLUMN IF NOT EXISTS jeans_label_id uuid;
