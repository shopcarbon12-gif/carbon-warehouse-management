import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import { rseriesPutJsonV3 } from "@/lib/server/lightspeed-rseries-client";

/**
 * Sets **qoh** for one shop on an R-Series item via `PUT …/Item/{itemID}.json`.
 * See Retail Item API: **ItemShops** / **ItemShop** with **shopID** or **itemShopID**.
 */
export async function rseriesPutItemShopQoh(
  creds: LightspeedSyncCredentialRow,
  itemId: number,
  shopId: number,
  qoh: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const safeQoh = Math.max(0, Math.min(999_999_999, Math.floor(qoh)));
  const path = `Item/${itemId}`;
  const body: Record<string, unknown> = {
    Item: {
      itemID: String(itemId),
      ItemShops: {
        ItemShop: [
          {
            shopID: String(shopId),
            qoh: String(safeQoh),
          },
        ],
      },
    },
  };
  return rseriesPutJsonV3(creds, path, body);
}
