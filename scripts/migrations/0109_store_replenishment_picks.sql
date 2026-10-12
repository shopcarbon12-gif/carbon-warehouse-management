-- Store Replenishment (handheld, Find & Locate): a POS sale's item lines are
-- picked from the back to refill the showroom. One row per picked sale line.
-- Picking changes nothing about stock — it only records "found and pulled",
-- shared by every handheld. Unchecking deletes the row.
CREATE TABLE IF NOT EXISTS store_replenishment_picks (
  sale_line_id   INTEGER PRIMARY KEY,
  sale_id        INTEGER NOT NULL,
  picked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_by      UUID,
  picked_by_name TEXT
);

CREATE INDEX IF NOT EXISTS store_replenishment_picks_sale_idx
  ON store_replenishment_picks (sale_id);
