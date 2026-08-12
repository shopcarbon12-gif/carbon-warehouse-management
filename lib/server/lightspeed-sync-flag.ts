/**
 * Lightspeed catalog sync — master switch (M1: WMS is the catalog source of truth).
 *
 * Products are now authored in WMS and published to Shopify. The Lightspeed
 * catalog pull is retired as a *source*: the code, every `ls_*` column, and
 * all RFID/EPC encoding stay exactly as they are — but the catalog sync is
 * DISABLED BY DEFAULT so it can never overwrite a WMS-authored/edited field
 * (description / sku / color / size / upc / archived).
 *
 * Nothing else about Lightspeed changes; only the catalog upsert is gated.
 * To run a one-off legacy pull, set `LIGHTSPEED_CATALOG_SYNC_ENABLED=1`.
 */
export function isLightspeedCatalogSyncEnabled(): boolean {
  return (process.env.LIGHTSPEED_CATALOG_SYNC_ENABLED ?? "").trim() === "1";
}

export const LIGHTSPEED_SYNC_DISABLED_MESSAGE =
  "Lightspeed catalog sync is disabled — WMS is now the catalog source of truth. " +
  "Products are authored in WMS and published to Shopify. " +
  "(Set LIGHTSPEED_CATALOG_SYNC_ENABLED=1 to run a legacy pull.)";
