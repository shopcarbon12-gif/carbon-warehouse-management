export type CatalogSyncVariantPayload = {
  lsSystemId: number;
  sku: string;
  upc: string | null;
  color: string | null;
  size: string | null;
  retailPrice: string | null;
  /** Total on-hand from Lightspeed when the API exposes it (R-Series qoh / shops, X-Series inventory fields). */
  onHandTotal: number | null;
};

export type CatalogSyncMatrixPayload = {
  /** Parent matrix numeric id when known (classic / simulated); optional for grouping. */
  matrixLsSystemId: number | null;
  description: string;
  brand: string | null;
  category: string | null;
  vendor: string | null;
  upc: string;
  variants: CatalogSyncVariantPayload[];
};
