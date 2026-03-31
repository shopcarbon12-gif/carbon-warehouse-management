-- WMS no longer integrates with Shopify; remove DB artifacts.
DELETE FROM integration_connections WHERE lower(provider) = 'shopify';
ALTER TABLE locations DROP COLUMN IF EXISTS shopify_location_id;
