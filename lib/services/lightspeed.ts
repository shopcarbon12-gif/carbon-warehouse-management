/**
 * Lightspeed POS quantities for **compare** views (not the same as persisted `custom_skus.ls_on_hand_total`).
 * Uses live catalog fetch when credentials allow; otherwise deterministic demo SKUs.
 */

import type { Pool } from "pg";
import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
import {
  credentialsLookUsableForLiveFetch,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import { tryFetchLightspeedCatalogProducts } from "@/lib/services/lightspeed-catalog-fetch";

export type LightspeedInventoryLine = {
  sku: string;
  quantity: number;
};

export type LightspeedCompareInventoryResult = {
  lines: LightspeedInventoryLine[];
  /** `live_catalog` = flattened variant on-hand from a successful LS catalog HTTP pull. */
  source: "live_catalog" | "simulated";
  detail?: string;
};

/** Merge duplicate SKUs (sum quantities). */
export function mergeInventoryLinesBySku(lines: LightspeedInventoryLine[]): LightspeedInventoryLine[] {
  const map = new Map<string, number>();
  for (const row of lines) {
    const sku = row.sku.trim();
    if (!sku) continue;
    map.set(sku, (map.get(sku) ?? 0) + Math.max(0, row.quantity));
  }
  return [...map.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Build POS-side lines from catalog sync matrices (variant `onHandTotal`). */
export function flattenCatalogMatricesToInventoryLines(
  matrices: CatalogSyncMatrixPayload[],
): LightspeedInventoryLine[] {
  const raw: LightspeedInventoryLine[] = [];
  for (const m of matrices) {
    for (const v of m.variants) {
      const sku = v.sku?.trim() ?? "";
      if (!sku) continue;
      const q = v.onHandTotal;
      raw.push({ sku, quantity: q != null && Number.isFinite(q) ? Math.max(0, Math.trunc(q)) : 0 });
    }
  }
  return mergeInventoryLinesBySku(raw);
}

/**
 * Mock POS on-hand quantities for a Lightspeed store/location id.
 * Deterministic per `lsLocationId` so comparisons are reproducible in dev.
 */
export async function getSimulatedLightspeedInventory(lsLocationId: string): Promise<LightspeedInventoryLine[]> {
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

/**
 * Resolve inventory for `/api/sync/compare`: try live catalog (same HTTP stack as full sync), else demo.
 */
export async function resolveLightspeedInventoryForCompare(
  pool: Pool,
  tenantId: string,
  lsLocationId: string,
): Promise<LightspeedCompareInventoryResult> {
  const creds = await getLightspeedCredentialsForSync(pool, tenantId);
  if (credentialsLookUsableForLiveFetch(creds)) {
    try {
      const live = await tryFetchLightspeedCatalogProducts(creds);
      if (live && live.length > 0) {
        const lines = flattenCatalogMatricesToInventoryLines(live);
        return {
          lines,
          source: "live_catalog",
          detail:
            "Quantities from Lightspeed catalog response (per-variant on-hand / qoh fields). Not shop-scoped unless the API payload is.",
        };
      }
    } catch (e) {
      console.warn("[lightspeed] compare live catalog fetch failed", e);
    }
  }

  const lines = await getSimulatedLightspeedInventory(lsLocationId);
  return {
    lines,
    source: "simulated",
    detail:
      "Demo SKUs — set Lightspeed credentials (R-Series or Retail X) and ensure catalog API returns stock fields.",
  };
}
