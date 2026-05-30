import type { Pool } from "pg";
import { decodeEpc } from "@/lib/server/epc-decode";
import { loadEpcConfig } from "@/lib/server/epc-ingress";

/**
 * Pure-read catalog enrichment for a batch of EPCs. Returns SKU / item
 * metadata without writing anything to `items`.
 *
 * Background — why this exists separate from `lookupTransferEpcs`:
 *   `lookupTransferEpcs` (in `operations-transfers.ts`) has a deliberate
 *   side effect: any EPC not yet in `items` gets ingested via the unified
 *   epc-ingress pipeline so the Transfer Out / bulk-status flows can
 *   "auto-flip a previously-unknown EPC to LIVE" on the fly. That's
 *   correct for those workflows because they're commissioning intent.
 *
 *   The Antenna Test workspace and any "show me what the reader sees"
 *   diagnostic view should NOT have that side effect — running a test
 *   shouldn't mutate inventory. Live evidence 2026-05-09: a test session
 *   on .69 silently created two `items` rows because the workspace
 *   re-used `/transfers/lookup` for catalog enrichment.
 *
 * This function decodes each EPC against the tenant's bit layout, looks
 * up `custom_skus.ls_system_id`, and returns the same row shape
 * `lookupTransferEpcs` produces, with `location_id` / `bin_id` /
 * `status` left null/derived since we never touched `items`.
 *
 * Status semantics:
 *   - 'in-stock'      — decoded successfully + catalog match
 *   - 'unknown'       — decoded successfully, no catalog match (would be
 *                       'tag_killed' if ingested; we don't want to imply
 *                       a kill happened, so use 'unknown' for clarity)
 *   - 'undecodable'   — wrong length / non-hex / wrong prefix
 *
 * Caller passes EPCs in any case; results carry uppercase EPC.
 */
export type CatalogEnrichRow = {
  epc: string;
  sku: string | null;
  /** Read-only join against items: populated when this EPC is already in inventory. */
  location_id: string | null;
  location_code: string | null;
  bin_id: string | null;
  bin_code: string | null;
  /**
   * 'in-stock' | 'unknown' | 'undecodable' — derived from decode + catalog
   * lookup. When an items row exists for this EPC the live items.status wins
   * (in-stock / sold / tag_killed / etc.) and is surfaced in `item_status`.
   */
  status: "in-stock" | "unknown" | "undecodable";
  /** Live items.status when an items row exists; null when the EPC was never ingested. */
  item_status: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  asset_id: string | null;
  vendor: string | null;
  retail_price: string | null;
  custom_sku_id: string | null;
  sku_ls_system_id: string | null;
};

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

export async function enrichEpcsByCatalog(
  pool: Pool,
  tenantId: string,
  epcs: string[],
): Promise<CatalogEnrichRow[]> {
  const norm = [...new Set(epcs.map(normalizeEpc))];
  if (norm.length === 0) return [];

  const client = await pool.connect();
  try {
    const config = await loadEpcConfig(client, tenantId);
    type Decoded = {
      epc: string;
      systemId: bigint | null;
      decoded: boolean;
    };
    const decodedList: Decoded[] = norm.map((epc) => {
      if (!config) return { epc, systemId: null, decoded: false };
      const r = decodeEpc(epc, config);
      return { epc, systemId: r.valid ? r.systemId : null, decoded: r.valid };
    });

    // Bulk-fetch catalog rows for every distinct system_id we decoded.
    const systemIds = [
      ...new Set(decodedList.filter((d) => d.systemId !== null).map((d) => d.systemId!.toString())),
    ];

    const skuRows = systemIds.length
      ? await client.query<{
          ls_system_id: string;
          sku: string;
          custom_sku_id: string;
          name: string | null;
          color: string | null;
          size: string | null;
          upc: string | null;
          asset_id: string | null;
          vendor: string | null;
          retail_price: string | null;
        }>(
          `SELECT
             cs.ls_system_id::text,
             cs.sku,
             cs.id::text AS custom_sku_id,
             m.description AS name,
             cs.color_code AS color,
             cs.size,
             COALESCE(cs.upc, m.upc) AS upc,
             cs.asset_id,
             m.vendor,
             cs.retail_price::text AS retail_price
           FROM custom_skus cs
           LEFT JOIN matrices m ON m.id = cs.matrix_id
           WHERE cs.ls_system_id::text = ANY($1::text[])`,
          [systemIds],
        )
      : { rows: [] as Array<{
          ls_system_id: string;
          sku: string;
          custom_sku_id: string;
          name: string | null;
          color: string | null;
          size: string | null;
          upc: string | null;
          asset_id: string | null;
          vendor: string | null;
          retail_price: string | null;
        }> };

    void tenantId; // tenant scope flows through the catalog at higher layers; mirrors encode-claim's note.

    const bySystemId = new Map(skuRows.rows.map((row) => [row.ls_system_id, row]));

    // Read-only join against items: surfaces live location_code / bin_code /
    // status when the EPC has already been ingested. NO writes — keeps the
    // diagnostic-safe contract intact (cf. transfers/lookup which auto-creates
    // items rows). Tenant-scoped to prevent cross-tenant leakage.
    // items has no `epc_hex` column (just `epc`) and no `tenant_id`
    // column — tenant scope flows through the locations join. The
    // query previously referenced both nonexistent columns and threw
    // "column i.epc_hex does not exist" on every catalog-enrich call.
    const itemsByEpc = norm.length
      ? new Map(
          (
            await client.query<{
              epc: string;
              status: string | null;
              location_code: string | null;
              location_id: string | null;
              bin_code: string | null;
              bin_id: string | null;
            }>(
              `SELECT
                 i.epc,
                 i.status,
                 i.location_id::text AS location_id,
                 l.code            AS location_code,
                 i.bin_id::text    AS bin_id,
                 b.code            AS bin_code
               FROM items i
               INNER JOIN locations l ON l.id = i.location_id
               LEFT JOIN bins      b ON b.id = i.bin_id
               WHERE l.tenant_id = $1::uuid
                 AND UPPER(i.epc) = ANY($2::text[])`,
              [tenantId, norm],
            )
          ).rows.map((r) => [r.epc.toUpperCase(), r] as const),
        )
      : new Map<
          string,
          {
            epc: string;
            status: string | null;
            location_code: string | null;
            location_id: string | null;
            bin_code: string | null;
            bin_id: string | null;
          }
        >();

    // C-prefix fallback: some tags encode the custom SKU directly in the first
    // 13 chars of the EPC (e.g. C11121246040518149709975 -> C111212460405).
    // For EPCs the binary formula couldn't resolve to a catalog row, decode the
    // SKU from the string and look it up so catalog columns (sku/description/
    // color/size/upc/price) still fill on every export — even for "not found"
    // / uncommissioned tags. custom_skus + matrices are single-tenant.
    type CatRow = {
      sku: string;
      custom_sku_id: string;
      name: string | null;
      color: string | null;
      size: string | null;
      upc: string | null;
      asset_id: string | null;
      vendor: string | null;
      retail_price: string | null;
      ls_system_id: string | null;
    };
    const needsCPrefix = decodedList.filter(
      (d) =>
        (d.systemId === null || !bySystemId.has(d.systemId.toString())) &&
        d.epc.startsWith("C") &&
        d.epc.length >= 13,
    );
    const cPrefixCodes = [...new Set(needsCPrefix.map((d) => d.epc.slice(0, 13)))];
    const cPrefixBySku = new Map<string, CatRow>();
    if (cPrefixCodes.length) {
      const rows = await client.query<CatRow & { sku_key: string }>(
        `SELECT UPPER(cs.sku) AS sku_key,
                cs.sku,
                cs.id::text AS custom_sku_id,
                m.description AS name,
                cs.color_code AS color,
                cs.size,
                COALESCE(cs.upc, m.upc) AS upc,
                cs.asset_id,
                m.vendor,
                cs.retail_price::text AS retail_price,
                cs.ls_system_id::text AS ls_system_id
           FROM custom_skus cs
           LEFT JOIN matrices m ON m.id = cs.matrix_id
          WHERE UPPER(cs.sku) = ANY($1::text[])`,
        [cPrefixCodes],
      );
      for (const r of rows.rows) cPrefixBySku.set(r.sku_key, r);
    }
    const cPrefixHit = (epc: string): CatRow | undefined =>
      epc.startsWith("C") && epc.length >= 13
        ? cPrefixBySku.get(epc.slice(0, 13))
        : undefined;

    return decodedList.map((d): CatalogEnrichRow => {
      const item = itemsByEpc.get(d.epc);
      const binaryHit =
        d.systemId !== null ? bySystemId.get(d.systemId.toString()) : undefined;
      const cat: CatRow | undefined = binaryHit ?? cPrefixHit(d.epc);
      if (!cat) {
        return {
          epc: d.epc,
          sku: null,
          location_id: item?.location_id ?? null,
          location_code: item?.location_code ?? null,
          bin_id: item?.bin_id ?? null,
          bin_code: item?.bin_code ?? null,
          status: d.decoded ? "unknown" : "undecodable",
          item_status: item?.status ?? null,
          name: null,
          color: null,
          size: null,
          upc: null,
          asset_id: null,
          vendor: null,
          retail_price: null,
          custom_sku_id: null,
          sku_ls_system_id: d.systemId !== null ? d.systemId.toString() : null,
        };
      }
      return {
        epc: d.epc,
        sku: cat.sku,
        location_id: item?.location_id ?? null,
        location_code: item?.location_code ?? null,
        bin_id: item?.bin_id ?? null,
        bin_code: item?.bin_code ?? null,
        status: "in-stock",
        item_status: item?.status ?? null,
        name: cat.name,
        color: cat.color,
        size: cat.size,
        upc: cat.upc,
        asset_id: cat.asset_id,
        vendor: cat.vendor,
        retail_price: cat.retail_price,
        custom_sku_id: cat.custom_sku_id,
        sku_ls_system_id:
          cat.ls_system_id ??
          (d.systemId !== null ? d.systemId.toString() : null),
      };
    });
  } finally {
    client.release();
  }
}
