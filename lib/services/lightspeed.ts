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
 * Sample/demo data was removed: this fallback now returns an empty result so the
 * compare workspace surfaces a credentials warning instead of fake SKUs.
 * Signature preserved for callers; argument is intentionally unused.
 */
export async function getSimulatedLightspeedInventory(_lsLocationId: string): Promise<LightspeedInventoryLine[]> {
  return [];
}

/**
 * Resolve inventory for `/api/sync/compare`: try live catalog (same HTTP stack as full sync), else demo.
 */
export async function resolveLightspeedInventoryForCompare(
  pool: Pool,
  tenantId: string,
  lsLocationId: string,
): Promise<LightspeedCompareInventoryResult> {
  const lsStrict = String(process.env.WMS_LS_STRICT ?? "").trim() === "1";
  const creds = await getLightspeedCredentialsForSync(pool, tenantId);

  if (!credentialsLookUsableForLiveFetch(creds)) {
    if (lsStrict) {
      throw new Error(
        "WMS_LS_STRICT=1: Lightspeed credentials incomplete for compare (same as catalog sync).",
      );
    }
  } else {
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
      if (lsStrict) {
        throw new Error("WMS_LS_STRICT=1: Lightspeed catalog API returned no products for compare.");
      }
    } catch (e) {
      if (lsStrict) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      console.warn("[lightspeed] compare live catalog fetch failed", e);
    }
  }

  const lines = await getSimulatedLightspeedInventory(lsLocationId);
  return {
    lines,
    source: "simulated",
    detail:
      "No simulated data available; configure Lightspeed credentials (R-Series OAuth: LS_ACCOUNT_ID + LS_CLIENT_* + LS_REFRESH_TOKEN, or X-Series fallback) and ensure the catalog API returns stock fields.",
  };
}
