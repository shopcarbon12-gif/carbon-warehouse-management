/**
 * Lightspeed Retail (X-Series / R-Series) inventory bridge — stub implementation.
 * Replace `getLightspeedInventory` with signed HTTP calls + pagination when credentials exist.
 */

export type LightspeedInventoryLine = {
  sku: string;
  quantity: number;
};

/**
 * Mock POS on-hand quantities for a Lightspeed store/location id.
 * Deterministic per `lsLocationId` so comparisons are reproducible in dev.
 */
export async function getLightspeedInventory(
  lsLocationId: string,
): Promise<LightspeedInventoryLine[]> {
  // Simulate network / rate limits without blocking the event loop too long.
  await new Promise((r) => setTimeout(r, 45));

  const key = (lsLocationId || "default").trim() || "default";

  const catalog: LightspeedInventoryLine[] = [
    { sku: "DEMO-SKU-001", quantity: 4 },
    { sku: "DEMO-SKU-002", quantity: 10 },
    { sku: "DEMO-SKU-003", quantity: 0 },
    { sku: "LS-ONLY-404", quantity: 6 },
  ];

  const bump = key.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 3;
  return catalog.map((row, i) => ({
    sku: row.sku,
    quantity: Math.max(0, row.quantity + (i === 0 ? bump - 1 : 0)),
  }));
}
