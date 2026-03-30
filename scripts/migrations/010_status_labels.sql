-- Status labels (Carbon WMS / legacy parity, slim schema — no legacy API/transfer/audit columns).
CREATE TABLE IF NOT EXISTS status_labels (
  id SERIAL PRIMARY KEY,
  legacy_id INTEGER UNIQUE,
  name TEXT NOT NULL UNIQUE,
  include_in_inventory BOOLEAN NOT NULL DEFAULT false,
  hide_in_search_filters BOOLEAN NOT NULL DEFAULT false,
  hide_in_item_details BOOLEAN NOT NULL DEFAULT false,
  display_in_group_page BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS status_labels_legacy_id_idx ON status_labels (legacy_id)
  WHERE legacy_id IS NOT NULL;
