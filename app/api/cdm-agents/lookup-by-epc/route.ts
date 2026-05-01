import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import { decodeEpc, type EpcConfig } from "@/lib/server/epc-decode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(500),
});

/**
 * Diagnostic lookup-by-EPC endpoint for the Carbon CDM agent. Authenticated
 * by the agent's Bearer token (NOT a user session). Decodes each EPC against
 * `tenant_epc_config` and joins to `custom_skus` + `matrices` so the agent
 * can build a single self-contained report (binary → EPC → systemId →
 * sku/description) without round-tripping per row.
 *
 * Body: { epcs: ["F0A0...", ...] } (24-char hex, max 500 per call).
 * Response: { rows: [{ epcHex, valid, reason?, prefixHex, systemId, serial,
 *                       sku, lsSystemId, color, size, productName }, ...] }
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const cfgRow = await pool.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid LIMIT 1`,
    [a.tenantId],
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

  const decodedList = parsed.data.epcs.map((rawEpc) => {
    const epcHex = rawEpc.trim().toUpperCase();
    const dec = decodeEpc(epcHex, cfg);
    return {
      epcHex,
      valid: dec.valid,
      reason: dec.reason,
      prefixHex: dec.prefixHex,
      systemId: dec.systemId !== null ? dec.systemId.toString() : null,
      serial: dec.serial !== null ? dec.serial.toString() : null,
    };
  });

  const validSystemIds = Array.from(
    new Set(
      decodedList
        .filter((d) => d.valid && d.systemId !== null)
        .map((d) => d.systemId as string),
    ),
  );

  type CatRow = {
    ls_system_id: string;
    sku: string;
    color_code: string | null;
    size: string | null;
    product_name: string;
  };
  const catalogMap = new Map<string, CatRow>();
  if (validSystemIds.length > 0) {
    const r = await pool.query<CatRow>(
      `SELECT
         cs.ls_system_id::text AS ls_system_id,
         cs.sku,
         cs.color_code,
         cs.size,
         m.description AS product_name
       FROM custom_skus cs
       LEFT JOIN matrices m ON m.id = cs.matrix_id
       WHERE cs.ls_system_id::text = ANY($1::text[])`,
      [validSystemIds],
    );
    for (const row of r.rows) {
      catalogMap.set(row.ls_system_id, row);
    }
  }

  const rows = decodedList.map((d) => {
    const cat = d.systemId ? catalogMap.get(d.systemId) : undefined;
    return {
      epcHex: d.epcHex,
      valid: d.valid,
      reason: d.reason ?? null,
      prefixHex: d.prefixHex,
      systemId: d.systemId,
      serial: d.serial,
      sku: cat?.sku ?? null,
      color: cat?.color_code ?? null,
      size: cat?.size ?? null,
      productName: cat?.product_name ?? null,
    };
  });

  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
