import type { PoolClient } from "pg";
import {
  applyBinPlan,
  clearHomeBin,
  listedCount,
  liveBinsOf,
  lockItems,
  planRemove,
  publicChanges,
  type BinActor,
  type BinChange,
} from "@/lib/server/bin-engine";

/**
 * Takes a bin off its tags — the whole bin (Clean / Empty bin) or one product
 * group (Shelf Map ✕, handheld swipe-remove / Remove from bin).
 *
 * Every tag that lists the bin loses it, whatever its status, so a cleaned bin
 * really is empty and a sold or unknown tag can't reappear in it later. A tag
 * whose PRIMARY bin this was gets its first live extra bin promoted to primary
 * (it used to be left with only extra bins: no bin in the catalog, but still
 * on the Shelf Map). The bin stops being the home bin of the SKUs it held.
 *
 * `skuPrefix` narrows to one group (`sku LIKE prefix%`); `matrixId` pins it
 * to ONE product — two matrices may share a UPC (migration 0092), and a
 * prefix-only remove used to clear the twin product too (Cole Pants GREY /
 * Kyle Cargo GREY).
 *
 * `cleared` counts the tags the operator saw in the bin (in-stock + pending
 * visibility); `changes` is before → after per EPC for an exact Undo.
 * Must run inside a transaction.
 */
export async function cleanBinContents(
  client: PoolClient,
  tenantId: string,
  binId: string,
  opts: { skuPrefix?: string | null; matrixId?: string | null; actor: BinActor },
): Promise<{ cleared: number; changes: BinChange[]; binCode: string }> {
  const bin = await client.query<{ code: string; location_id: string }>(
    `SELECT b.code, b.location_id::text
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE b.id = $1::uuid AND l.tenant_id = $2::uuid AND b.archived_at IS NULL
     LIMIT 1`,
    [binId, tenantId],
  );
  const row = bin.rows[0];
  if (!row) throw new Error("NOT_FOUND");

  const prefix = (opts.skuPrefix ?? "").trim();
  const params: unknown[] = [binId];
  let groupClause = "";
  if (prefix) {
    params.push(`${prefix}%`, opts.matrixId ?? null);
    groupClause = `AND i.custom_sku_id IN (
         SELECT id FROM custom_skus WHERE sku LIKE $2 AND ($3::uuid IS NULL OR matrix_id = $3::uuid))`;
  }
  const rows = await lockItems(
    client,
    `(i.bin_id = $1::uuid OR $1::uuid = ANY(i.additional_bin_ids)) ${groupClause}`,
    params,
  );
  const live = await liveBinsOf(client, row.location_id);
  live.delete(binId);
  const changes = await applyBinPlan(client, tenantId, rows, planRemove(binId, live), opts.actor);

  if (prefix) {
    const skus = await client.query<{ id: string }>(
      `SELECT id::text FROM custom_skus WHERE sku LIKE $1 AND ($2::uuid IS NULL OR matrix_id = $2::uuid)`,
      [`${prefix}%`, opts.matrixId ?? null],
    );
    await clearHomeBin(client, binId, skus.rows.map((s) => s.id));
  } else {
    await clearHomeBin(client, binId, "all");
  }

  return { cleared: listedCount(changes), changes: publicChanges(changes), binCode: row.code };
}
