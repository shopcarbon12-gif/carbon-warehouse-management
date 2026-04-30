import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { buildRfidReftagZpl } from "@/lib/utils/zpl-rfid-reftag";
import { parsePrinterLine } from "@/components/rfid/commissioning/commissioning-settings-panel";
import { rfidCommissionPrintAndAudit } from "@/lib/server/rfid-commission";

/**
 * POST /api/rfid/reprint — reprint an existing item's label without inserting
 * new EPCs. Looks up the item + custom_sku, builds a single-label ZPL via
 * the same generator the commissioning page uses, posts to the chosen printer.
 *
 * Body: { epc, printerId? | printerLine? | (printerIp + printerPort + printerUri),
 *         labelDimensions?: { w, h } }
 *
 * If neither a printerId nor explicit printer fields are given the endpoint
 * falls back to the same default the commissioning page uses
 * (192.168.1.3:80 / PSTPRNT).
 */

const bodySchema = z.object({
  epc: z
    .string()
    .transform((s) => s.replace(/\s/g, "").toUpperCase())
    .refine((s) => /^[0-9A-F]{24}$/.test(s), "Invalid 24-char hex EPC"),
  printerId: z.string().uuid().optional(),
  printerLine: z.string().max(256).optional(),
  printerIp: z.string().max(128).optional(),
  printerPort: z.coerce.number().int().min(1).max(65535).optional(),
  printerUri: z.string().max(64).optional(),
  labelDimensions: z
    .object({
      w: z.coerce.number().int().min(100).optional(),
      h: z.coerce.number().int().min(100).optional(),
    })
    .optional(),
});

const DEFAULT_PRINTER_LINE = "192.168.1.3:80 / PSTPRNT";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Resolve printer settings — printerId > printerLine > explicit > default.
  let printerHost: string | null = null;
  let printerPort: number | null = null;
  let printerUri: string | null = null;

  if (parsed.data.printerId) {
    const r = await pool.query<{ network_address: string | null }>(
      `SELECT network_address FROM devices
       WHERE id = $1::uuid AND tenant_id = $2::uuid AND device_type = 'printer' LIMIT 1`,
      [parsed.data.printerId, session.tid],
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Printer not found" }, { status: 404 });
    }
    const line = r.rows[0]?.network_address ?? DEFAULT_PRINTER_LINE;
    const p = parsePrinterLine(line);
    printerHost = p.host;
    printerPort = p.port;
    printerUri = p.uri;
  } else if (parsed.data.printerLine) {
    const p = parsePrinterLine(parsed.data.printerLine);
    printerHost = p.host;
    printerPort = p.port;
    printerUri = p.uri;
  } else if (parsed.data.printerIp) {
    printerHost = parsed.data.printerIp;
    printerPort = parsed.data.printerPort ?? 80;
    printerUri = parsed.data.printerUri ?? "PSTPRNT";
  } else {
    const p = parsePrinterLine(DEFAULT_PRINTER_LINE);
    printerHost = p.host;
    printerPort = p.port;
    printerUri = p.uri;
  }

  // Look up the EPC's matrix + custom SKU info to fill the label.
  const r = await pool.query<{
    epc: string;
    sku: string;
    sku_ls_system_id: string | null;
    name: string | null;
    upc: string | null;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       cs.ls_system_id::text AS sku_ls_system_id,
       m.description AS name,
       COALESCE(cs.upc, m.upc) AS upc
     FROM items i
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     WHERE i.epc = $2::text LIMIT 1`,
    [session.tid, parsed.data.epc],
  );
  const item = r.rows[0];
  if (!item) {
    return NextResponse.json({ error: "EPC not found in this tenant" }, { status: 404 });
  }

  const zpl = buildRfidReftagZpl(
    {
      epc: item.epc,
      sku: item.sku,
      description: item.name,
      systemId: item.sku_ls_system_id ?? "",
      upc: item.upc,
      pw: parsed.data.labelDimensions?.w ?? 812,
      ll: parsed.data.labelDimensions?.h ?? 594,
    },
    true,
  );

  const outcome = await rfidCommissionPrintAndAudit(pool, session, {
    zpl,
    printerHost,
    printerPort,
    printerUri,
    meta: {
      reprint: true,
      epc: item.epc,
      sku: item.sku,
      ls_system_id: item.sku_ls_system_id,
    },
  });

  if (!outcome.printer_ok) {
    return NextResponse.json(
      { error: outcome.printer_error ?? "Printer rejected the job", outcome },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, outcome });
}
