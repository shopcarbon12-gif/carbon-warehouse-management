import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { decodeEpc, type EpcConfig } from "@/lib/server/epc-decode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/handheld/epc-lookup
 *
 * Bulk EPC → SKU + name + color + size enrichment for handheld screens.
 * Mirrors the CDM-agent lookup-by-epc shape, but auths via the handheld
 * dual-auth (session OR edge-key). Used by Add-On Count to populate the
 * review screen with product info after a scan.
 *
 * Body: { epcs: [...], deviceId?: '...' }   (max 500 EPCs/call)
 * Reply: { rows: [{ epcHex, valid, reason, systemId, serial, sku, color, size, productName }] }
 */
const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(500),
  deviceId: z.string().min(1).max(256).optional(),
});

export async function POST(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

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

  const auth = await resolveTenantOrError(req, pool, parsed.data.deviceId);
  if (auth instanceof Response) return auth;

  const cfgRow = await pool.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid LIMIT 1`,
    [auth.tenantId],
  );
  if (cfgRow.rowCount === 0) {
    return NextResponse.json({ error: "No tenant_epc_config" }, { status: 412 });
  }
  const cfg: EpcConfig = {
    prefixHex: cfgRow.rows[0]!.prefix_hex,
    prefixBits: cfgRow.rows[0]!.prefix_bits,
    assetBits: cfgRow.rows[0]!.asset_bits,
    serialBits: cfgRow.rows[0]!.serial_bits,
    assetPaddingDigits: cfgRow.rows[0]!.asset_padding_digits,
  };

  const decoded = parsed.data.epcs.map((rawEpc) => {
    const epcHex = rawEpc.trim().toUpperCase();
    const d = decodeEpc(epcHex, cfg);
    return {
      epcHex,
      valid: d.valid,
      reason: d.reason ?? null,
      systemId: d.systemId !== null ? d.systemId.toString() : null,
      serial: d.serial !== null ? d.serial.toString() : null,
    };
  });

  const validSystemIds = Array.from(
    new Set(
      decoded.filter((d) => d.valid && d.systemId !== null).map((d) => d.systemId as string),
    ),
  );

  type CatRow = {
    ls_system_id: string;
    sku: string;
    color_code: string | null;
    size: string | null;
    product_name: string;
  };
  const catalog = new Map<string, CatRow>();
  if (validSystemIds.length > 0) {
    const r = await pool.query<CatRow>(
      `SELECT cs.ls_system_id::text AS ls_system_id, cs.sku, cs.color_code, cs.size,
              m.description AS product_name
         FROM custom_skus cs
         LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.ls_system_id::text = ANY($1::text[])`,
      [validSystemIds],
    );
    for (const row of r.rows) catalog.set(row.ls_system_id, row);
  }

  // Per-EPC current items.status. Null = no items row exists yet, which
  // is the "fresh EPC, will be ingested as in-stock on upload" case the
  // mobile Count Inventory screen treats as a valid container (matches
  // the LIVE-or-no-row classification documented in
  // 019_clean_10_status_architecture.sql + 0080_unknown_status.sql).
  //
  // Scoped only by tenant — multiple locations of the same tenant can
  // share an EPC over time (chip moves, gets re-encoded). Caller is
  // responsible for treating "in-stock at another location" however they
  // want; we just return the status string.
  type ItemRow = { epc: string; status: string };
  const itemStatus = new Map<string, string>();
  const epcsForLookup = decoded.map((d) => d.epcHex);
  if (epcsForLookup.length > 0) {
    const r = await pool.query<ItemRow>(
      `SELECT i.epc, i.status
         FROM items i
         INNER JOIN locations l ON l.id = i.location_id
        WHERE l.tenant_id = $1::uuid
          AND i.epc = ANY($2::text[])`,
      [auth.tenantId, epcsForLookup],
    );
    for (const row of r.rows) itemStatus.set(row.epc, row.status);
  }

  const rows = decoded.map((d) => {
    const cat = d.systemId ? catalog.get(d.systemId) : undefined;
    return {
      epcHex: d.epcHex,
      valid: d.valid,
      reason: d.reason,
      systemId: d.systemId,
      serial: d.serial,
      sku: cat?.sku ?? null,
      color: cat?.color_code ?? null,
      size: cat?.size ?? null,
      productName: cat?.product_name ?? null,
      // items.status for the chip. null when no items row exists for
      // this EPC under this tenant — handheld treats that as "fresh,
      // count as valid (upload promotes to in-stock)".
      status: itemStatus.get(d.epcHex) ?? null,
    };
  });

  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
