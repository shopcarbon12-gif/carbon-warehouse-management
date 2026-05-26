import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { decodeEpc } from "@/lib/server/epc-decode";
import { loadEpcConfig } from "@/lib/server/epc-ingress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk-Import scan-batch endpoint. The page's SSE stream pushes raw
 * EPCs into the workspace; the workspace ships them here in batches.
 * We:
 *   1. Validate hex shape, dedup the batch.
 *   2. Filter out EPCs already in `items` at THIS location (regardless
 *      of status — operator's intent is "brand-new EPCs only"; an EPC
 *      that's been sold or tag_killed at this location still counts as
 *      "known" and gets excluded).
 *   3. Decode the rest against the tenant's EPC formula. Anything that
 *      fails (wrong prefix, bad hex, bad config) is dropped — the
 *      page only displays catalog-matched rows.
 *   4. Resolve each surviving system_id to the catalog row via
 *      custom_skus + matrices. Drop EPCs whose system_id doesn't match
 *      any custom_sku for this tenant.
 *   5. Return enriched rows for the workspace to merge into its table.
 *
 * The endpoint is intentionally idempotent: re-shipping the same EPC
 * batch yields the same response. Client deduplication is a courtesy,
 * not a contract.
 */
const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(500),
});

type EnrichedRow = {
  epc: string;
  custom_sku_id: string;
  sku: string;
  upc: string | null;
  name: string;
  size: string | null;
  color: string | null;
  system_id: string;
};

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // Step 1: normalize + dedup + shape-validate. Anything that's not
  // 24 hex chars is dropped silently — the SSE stream legitimately
  // carries shorter / partial values during framing edge cases.
  const epcs = Array.from(
    new Set(
      parsed.data.epcs
        .map((e) => e.replace(/\s/g, "").toUpperCase())
        .filter((e) => /^[0-9A-F]{24}$/.test(e)),
    ),
  );
  if (epcs.length === 0) {
    return NextResponse.json({ ok: true, rows: [] });
  }

  const client = await pool.connect();
  try {
    // Step 2: drop EPCs already in items at this location.
    const knownRows = await client.query<{ epc: string }>(
      `SELECT epc FROM items
        WHERE location_id = $1::uuid
          AND epc = ANY($2::text[])`,
      [session.lid, epcs],
    );
    const known = new Set(knownRows.rows.map((r) => r.epc.toUpperCase()));
    const fresh = epcs.filter((e) => !known.has(e));
    if (fresh.length === 0) {
      return NextResponse.json({ ok: true, rows: [], filtered_known: epcs.length });
    }

    // Step 3: decode against the tenant's formula. Anything failing
    // the prefix / shape check is dropped — the bulk-import table
    // only ever displays catalog-matched rows.
    const epcConfig = await loadEpcConfig(client, session.tid);
    if (!epcConfig) {
      // No tenant_epc_config row → formula can't be evaluated. Treat
      // every EPC as a non-match; surfaces no rows to the operator.
      return NextResponse.json({
        ok: true,
        rows: [],
        filtered_known: known.size,
        filtered_no_config: fresh.length,
      });
    }

    const decoded: Array<{ epc: string; system_id: string }> = [];
    let filteredBadFormula = 0;
    for (const epc of fresh) {
      const d = decodeEpc(epc, epcConfig);
      if (!d.valid || d.systemId === null) {
        filteredBadFormula++;
        continue;
      }
      decoded.push({ epc, system_id: d.systemId.toString() });
    }
    if (decoded.length === 0) {
      return NextResponse.json({
        ok: true,
        rows: [],
        filtered_known: known.size,
        filtered_bad_formula: filteredBadFormula,
      });
    }

    // Step 4: resolve system_ids to catalog rows. custom_skus has no
    // tenant_id column on this deployment (see encode-claim comment) —
    // tenant scope flows through matrices.brand / catalog at higher
    // layers; here, the input EPCs already passed our tenant's prefix
    // formula above so we don't need extra tenant filtering.
    const systemIds = Array.from(new Set(decoded.map((d) => d.system_id)));
    const skuRows = await client.query<{
      custom_sku_id: string;
      ls_system_id: string;
      sku: string;
      upc: string | null;
      name: string;
      size: string | null;
      color: string | null;
    }>(
      `SELECT cs.id::text  AS custom_sku_id,
              cs.ls_system_id::text AS ls_system_id,
              cs.sku        AS sku,
              cs.upc        AS upc,
              m.description AS name,
              cs.size       AS size,
              cs.color_code AS color
         FROM custom_skus cs
         INNER JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.ls_system_id::text = ANY($1::text[])`,
      [systemIds],
    );
    const skuBySystemId = new Map(skuRows.rows.map((r) => [r.ls_system_id, r]));

    const rows: EnrichedRow[] = [];
    let filteredNoCatalog = 0;
    for (const d of decoded) {
      const sku = skuBySystemId.get(d.system_id);
      if (!sku) {
        filteredNoCatalog++;
        continue;
      }
      rows.push({
        epc: d.epc,
        custom_sku_id: sku.custom_sku_id,
        sku: sku.sku,
        upc: sku.upc,
        name: sku.name,
        size: sku.size,
        color: sku.color,
        system_id: d.system_id,
      });
    }

    return NextResponse.json({
      ok: true,
      rows,
      filtered_known: known.size,
      filtered_bad_formula: filteredBadFormula,
      filtered_no_catalog: filteredNoCatalog,
    });
  } finally {
    client.release();
  }
}
