import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import { rseriesPostJsonV3 } from "@/lib/server/lightspeed-rseries-client";

/** Lightspeed allows up to 100 transfer lines per AddItems call. */
export const LS_TRANSFER_ADD_ITEMS_MAX = 100;

export type RSeriesTransferLineInput = { itemID: number; toSend: number };

/**
 * POST …/Inventory/Transfer/{transferID}/AddItems.json
 * @see https://developers.lightspeedhq.com/retail/endpoints/Inventory-Transfer-TransferItems/
 */
export async function rseriesInventoryTransferAddItems(
  creds: LightspeedSyncCredentialRow,
  transferId: string,
  items: RSeriesTransferLineInput[],
  timeoutMs = 45_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const tid = transferId.trim();
  if (!tid) return { ok: false, status: 400, body: { error: "Missing transferId" } };
  const payload: Record<string, unknown> = {
    TransferItems: items.map((i) => ({
      toSend: String(i.toSend),
      itemID: String(i.itemID),
    })),
  };
  return rseriesPostJsonV3(creds, `Inventory/Transfer/${tid}/AddItems`, payload, timeoutMs);
}

/**
 * POST …/Inventory/Transfer/{transferID}/Send.json (body `{}`)
 */
export async function rseriesInventoryTransferSend(
  creds: LightspeedSyncCredentialRow,
  transferId: string,
  timeoutMs = 45_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const tid = transferId.trim();
  if (!tid) return { ok: false, status: 400, body: { error: "Missing transferId" } };
  return rseriesPostJsonV3(creds, `Inventory/Transfer/${tid}/Send`, {}, timeoutMs);
}

export function chunkTransferItems<T>(items: T[], size = LS_TRANSFER_ADD_ITEMS_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
