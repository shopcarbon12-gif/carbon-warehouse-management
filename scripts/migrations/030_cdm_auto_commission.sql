-- v3.2: Placeholder SKU/matrix for Carbon CDM auto-commissioning.
-- When the agent receives an EPC that isn't in items yet, it auto-creates
-- an items row pointing at this placeholder SKU + the reader's location.
-- The operator can reassign to a real SKU later via the catalog UI.

INSERT INTO matrices (description, brand, vendor, ls_system_id)
SELECT 'Auto-commissioned (Pending)', 'CARBON', 'CARBON', -1::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM matrices WHERE description = 'Auto-commissioned (Pending)'
);
--> statement-breakpoint

INSERT INTO custom_skus (matrix_id, sku, ls_system_id, asset_id)
SELECT m.id, 'AUTO-PENDING', -1::bigint, 'AUTO-PENDING'
FROM matrices m
WHERE m.description = 'Auto-commissioned (Pending)'
  AND NOT EXISTS (SELECT 1 FROM custom_skus WHERE sku = 'AUTO-PENDING');
