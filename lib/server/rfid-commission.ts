import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { generateSGTIN96 } from "@/lib/epc";
import {
  buildRfidReftagZplBatch,
  type RfidReftagZplLabel,
} from "@/lib/utils/zpl-rfid-reftag";

export const commissionBodySchema = z
  .object({
    customSkuId: z.string().uuid(),
    qty: z.coerce.number().int().min(1).max(500),
    binId: z.string().uuid().nullable().optional(),
    addToInventory: z.coerce.boolean().optional().default(false),
    companyPrefix: z.coerce.number().int().min(0).optional(),
    /** Printer host (e.g. 192.168.1.3) */
    printerIp: z.string().max(128).optional(),
    printerPort: z.coerce.number().int().min(1).max(65535).optional(),
    printerUri: z.string().max(64).optional(),
    labelDimensions: z
      .object({
        w: z.coerce.number().int().min(100),
        h: z.coerce.number().int().min(100),
      })
      .optional(),
  })
  .refine((d) => !d.addToInventory || Boolean(d.binId), {
    message: "binId is required when addToInventory is true",
    path: ["binId"],
  });

export type CommissionBody = z.infer<typeof commissionBodySchema>;

export type SessionPayload = {
  sub: string;
  tid: string;
  lid: string;
};

export function envCompanyPrefix(): number {
  const raw = process.env.WMS_COMPANY_PREFIX?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1_044_991;
}

export function buildPrinterRawUrl(host: string, port: number, uri: string): string {
  const path = uri.startsWith("/") ? uri : `/${uri.replace(/^\/+/, "")}`;
  return `http://${host}:${port}${path}`;
}

export type PrepareResult = {
  zpl: string;
  inserted: { epc: string; serial_number: number }[];
  status_final: string;
  meta: Record<string, unknown>;
};

/**
 * Transaction: load matrix/custom SKU, insert items, build ZPL batch. No printer / no audit.
 */
export async function rfidCommissionPrepare(
  client: PoolClient,
  session: SessionPayload,
  body: CommissionBody,
): Promise<PrepareResult> {
  const {
    customSkuId,
    qty,
    binId,
    addToInventory,
    companyPrefix: bodyCp,
    printerIp,
    printerPort,
    printerUri,
    labelDimensions,
  } = body;

  const pw = labelDimensions?.w ?? 812;
  const ll = labelDimensions?.h ?? 594;

  const cs = await client.query<{
    id: string;
    ls_system_id: string;
    sku: string;
    upc: string;
    description: string;
  }>(
    `SELECT cs.id, cs.ls_system_id::text, cs.sku, m.upc, m.description
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     WHERE cs.id = $1::uuid
     LIMIT 1`,
    [customSkuId],
  );
  const row = cs.rows[0];
  if (!row) {
    throw new Error("NOT_FOUND:Custom SKU not found");
  }

  if (binId) {
    const binOk = await client.query<{ ok: string }>(
      `SELECT 1::text AS ok FROM bins WHERE id = $1::uuid AND location_id = $2::uuid`,
      [binId, session.lid],
    );
    if (!binOk.rows[0]) {
      throw new Error("BAD_REQUEST:Bin not in this location");
    }
  }

  const maxSn = await client.query<{ m: string }>(
    `SELECT coalesce(max(serial_number), 0)::text AS m
     FROM items
     WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid`,
    [row.id, session.lid],
  );
  const nextSerial = Number(maxSn.rows[0]?.m ?? 0) + 1;

  const cp = bodyCp ?? envCompanyPrefix();
  const lsId = Number(row.ls_system_id);
  if (!Number.isFinite(lsId)) {
    throw new Error("SERVER:Invalid ls_system_id on SKU");
  }

  const statusFinal = addToInventory ? "in-stock" : "pending_visibility";
  const inserted: { epc: string; serial_number: number }[] = [];
  const zplRows: RfidReftagZplLabel[] = [];
  const dateStr = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < qty; i += 1) {
    const serial = nextSerial + i;
    const epc = generateSGTIN96(cp, lsId, serial);
    await client.query(
      `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, bin_id, status)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6)`,
      [epc, serial, row.id, session.lid, binId ?? null, statusFinal],
    );
    inserted.push({ epc, serial_number: serial });
    zplRows.push({
      epc,
      sku: row.sku,
      description: row.description,
      systemId: row.ls_system_id,
      upc: row.upc,
      dateStr,
      pw,
      ll,
    });
  }

  const zpl = buildRfidReftagZplBatch(zplRows);

  const meta: Record<string, unknown> = {
    custom_sku_id: row.id,
    sku: row.sku,
    upc: row.upc,
    description: row.description,
    lightspeed_system_id: row.ls_system_id,
    qty,
    add_to_inventory: addToInventory,
    status_final: statusFinal,
    company_prefix: cp,
    item_ref_bits: 40,
    serial_bits: 36,
    printer_ip: printerIp ?? "192.168.1.3",
    printer_port: printerPort ?? 80,
    printer_uri: printerUri ?? "PSTPRNT",
    label_dimensions: { w: pw, h: ll },
    bin_id: binId ?? null,
    inserted,
  };

  return { zpl, inserted, status_final: statusFinal, meta };
}

export const printBodySchema = z.object({
  zpl: z.string().min(1),
  printerHost: z.string().max(128),
  printerPort: z.coerce.number().int().min(1).max(65535),
  printerUri: z.string().max(64),
  meta: z.any(),
});

export type PrintBody = z.infer<typeof printBodySchema>;

export type PrintOutcome = {
  printer_ok: boolean;
  http_status: number | null;
  printer_error: string | null;
  printer_url: string;
};

const DEFAULT_PRINT_TIMEOUT_MS = 12_000;

export async function rfidCommissionPrintAndAudit(
  pool: Pool,
  session: SessionPayload,
  body: PrintBody,
): Promise<PrintOutcome> {
  const parsed = printBodySchema.parse(body);
  const url = buildPrinterRawUrl(
    parsed.printerHost,
    parsed.printerPort,
    parsed.printerUri,
  );

  let printer_ok = false;
  let http_status: number | null = null;
  let printer_error: string | null = null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Accept: "text/plain, */*",
      },
      body: parsed.zpl,
      signal: AbortSignal.timeout(DEFAULT_PRINT_TIMEOUT_MS),
    });
    http_status = res.status;
    printer_ok = res.ok;
    if (!res.ok) {
      printer_error = `HTTP ${res.status}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network error";
    printer_error = msg.includes("aborted") ? "Printer timeout" : msg;
    printer_ok = false;
  }

  const baseMeta =
    typeof parsed.meta === "object" && parsed.meta !== null && !Array.isArray(parsed.meta)
      ? (parsed.meta as Record<string, unknown>)
      : {};
  const auditPayload = {
    ...baseMeta,
    phase: "print",
    printer_success: printer_ok,
    printer_error,
    http_status,
    printer_url: url,
  };

  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_print', 'items', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify(auditPayload)],
  );

  return {
    printer_ok,
    http_status,
    printer_error,
    printer_url: url,
  };
}
