-- Jeans labels are pasted into the Pose 7 render as photographed, so the stored
-- picture must be the patch alone. Cropping keeps the original photo here and
-- points image_url at the cropped copy; a re-crop always starts from the original.
ALTER TABLE studio_jeans_labels ADD COLUMN IF NOT EXISTS source_url text;
