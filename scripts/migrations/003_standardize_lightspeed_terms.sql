-- Lightspeed-aligned naming: Matrix / Custom SKU / Item (EPC).
-- Requires 002_matrix_architecture.sql applied.

DROP INDEX IF EXISTS items_variant_id_status_idx;
--> statement-breakpoint
ALTER TABLE products RENAME TO matrices;
--> statement-breakpoint
ALTER TABLE matrices RENAME COLUMN title TO description;
--> statement-breakpoint
ALTER TABLE variants RENAME TO custom_skus;
--> statement-breakpoint
ALTER TABLE custom_skus RENAME COLUMN product_id TO matrix_id;
--> statement-breakpoint
ALTER TABLE items RENAME COLUMN variant_id TO custom_sku_id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_custom_sku_id_status_idx ON items (custom_sku_id, status);
