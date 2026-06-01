import type { Pool, PoolClient } from "pg";
import * as net from "node:net";
import { z } from "zod";
import { generateSGTIN96 } from "@/lib/epc";
import { pickRandomUniqueSerialBatch } from "@/lib/server/rfid-serial-allocator";
import {
  generateCarbonTagZpl,
  generateCarbonTagBatch,
  DEFAULT_CARBON_TAG_SETTINGS,
  type CarbonTagInput,
} from "@/lib/utils/zpl-carbon-tag";

export const commissionBodySchema = z.object({
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
  /** Explicit status for the created item(s). When set, overrides the
   *  addToInventory-derived default. The catalog popup's Print Label button
   *  passes "unknown" — print a tag for the SKU without committing it to live
   *  stock (it's promoted later, e.g. by the re-encode finalize flow). */
  status: z.enum(["in-stock", "pending_visibility", "unknown"]).optional(),
});
// Pre-1.2.42 we required `binId` whenever `addToInventory=true`. The web
// commissioning page picks a bin in the form and always passed it, so the
// refine was a UX safety net there. The handheld Print screen has no bin
// step — operators print first, assign bins via Bin Assign later — so the
// refine has been dropped. items.bin_id is nullable in the schema; null
// just means "unassigned." Web callers continue to send binId because
// their UI captures it; handheld omits it and the row inserts with
// bin_id=NULL.

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
  // Carbon Jeans tenant prefix per Senitron settings page
  // (encoding standard SENITRON, hex F0A0B). Verified 2026-05-05 against
  // 23,745 in-stock tags from inventory_export — 100 % use prefix 985611.
  // The prior default of 1_044_991 (hex FF1FF) was a placeholder that
  // never matched live tags and would have stamped the wrong prefix on
  // any commission call that didn't pass an explicit `companyPrefix`.
  return 985_611;
}

export function buildPrinterRawUrl(host: string, port: number, uri: string): string {
  // The Zebra ZD500R-300dpi web-print endpoint is **case-sensitive**:
  //   GET /pstprnt → 200, GET /PSTPRNT → 404 (verified on 192.168.1.3).
  // Most of the codebase carries the URI as "PSTPRNT" (matches Zebra's
  // historical docs) — lowercase it here at the URL-construction layer
  // so every caller wins, regardless of where the input came from.
  const lowered = uri.toLowerCase();
  const path = lowered.startsWith("/") ? lowered : `/${lowered.replace(/^\/+/, "")}`;
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

  const pw = labelDimensions?.w ?? DEFAULT_CARBON_TAG_SETTINGS.labelWidthDots;
  const ll = labelDimensions?.h ?? DEFAULT_CARBON_TAG_SETTINGS.labelHeightDots;

  // 1.2.49 — pull the extra columns the carbon-gen layout needs:
  // color_code, size, retail_price. Also collect every size in the
  // matrix so the right-hand "sizes available" column on the label
  // shows the full size run, not just this SKU's size.
  const cs = await client.query<{
    id: string;
    ls_system_id: string;
    sku: string;
    upc: string;
    description: string;
    color_code: string | null;
    size: string | null;
    retail_price: string | null;
    matrix_id: string;
  }>(
    `SELECT cs.id, cs.ls_system_id::text, cs.sku,
            COALESCE(NULLIF(trim(cs.upc), ''), m.upc) AS upc,
            m.description,
            cs.color_code,
            cs.size,
            cs.retail_price::text AS retail_price,
            cs.matrix_id::text AS matrix_id
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

  // Bin resolution. A bin is never *required*. When the caller adds to
  // inventory but picks no bin (binId null), the new EPCs inherit the bin
  // where existing in-stock items of the SAME UPC (matrix) already live —
  // most-populated bin wins. If this UPC has never been binned, the rows
  // stay unassigned (bin_id NULL). "Lives wherever its UPC lives, else null."
  let resolvedBinId: string | null = binId ?? null;
  if (!resolvedBinId && addToInventory) {
    const inherit = await client.query<{ bin_id: string }>(
      `SELECT i.bin_id
         FROM items i
         JOIN custom_skus cs2 ON cs2.id = i.custom_sku_id
        WHERE cs2.matrix_id = $1::uuid
          AND i.location_id = $2::uuid
          AND i.status = 'in-stock'
          AND i.bin_id IS NOT NULL
        GROUP BY i.bin_id
        ORDER BY count(*) DESC
        LIMIT 1`,
      [row.matrix_id, session.lid],
    );
    resolvedBinId = inherit.rows[0]?.bin_id ?? null;
  }

  // Random 6-digit unique serials per Carbon-Jeans policy (2026-05-29).
  // The batch allocator pre-checks against existing items.serial_number
  // for this sku AND keeps an in-batch Set so the qty draws can't
  // collide with each other. Two parallel commission requests for the
  // same sku could still pick the same random number — items.epc
  // UNIQUE will reject the second INSERT and the route bubbles a 23505
  // error (rare; caller's "Retry" button covers it).
  const serials = await pickRandomUniqueSerialBatch(client, row.id, qty);

  const cp = bodyCp ?? envCompanyPrefix();
  const lsId = Number(row.ls_system_id);
  if (!Number.isFinite(lsId)) {
    throw new Error("SERVER:Invalid ls_system_id on SKU");
  }

  // Collect the full set of sizes in this matrix for the
  // "sizes available" column. normalizeSizesColumn will dedupe and
  // format. Empty array → carbon-gen default "XS, S, M, L".
  const sizesRow = await client.query<{ size: string | null }>(
    `SELECT DISTINCT size FROM custom_skus
       WHERE matrix_id = $1::uuid AND archived = false AND size IS NOT NULL
       ORDER BY size`,
    [row.matrix_id],
  );
  const sizesAvailable = sizesRow.rows
    .map((r) => (r.size ?? "").trim())
    .filter(Boolean)
    .join(", ");

  const tagSettings = {
    ...DEFAULT_CARBON_TAG_SETTINGS,
    companyPrefix: cp,
    labelWidthDots: pw,
    labelHeightDots: ll,
  };

  const statusFinal = body.status ?? (addToInventory ? "in-stock" : "pending_visibility");
  const inserted: { epc: string; serial_number: number }[] = [];
  const zplLabels: string[] = [];

  const tagInput: CarbonTagInput = {
    itemName: row.description ?? "",
    color: row.color_code ?? "",
    size: row.size ?? "",
    upc: row.upc ?? "",
    customSku: row.sku,
    retailPrice: row.retail_price ?? "0",
    sizesAvailable,
  };

  for (let i = 0; i < qty; i += 1) {
    const serial = serials[i]!;
    const epc = generateSGTIN96(cp, lsId, serial);
    await client.query(
      `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, bin_id, status, created_by_user_id)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid)`,
      [epc, serial, row.id, session.lid, resolvedBinId, statusFinal, session.sub],
    );
    inserted.push({ epc, serial_number: serial });
    zplLabels.push(
      generateCarbonTagZpl({
        input: tagInput,
        settings: tagSettings,
        epcWrite: { companyPrefix: cp, itemNumber: lsId, serialNumber: serial },
      }),
    );
  }

  const zpl = generateCarbonTagBatch(zplLabels);

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

/**
 * Raw TCP / JetDirect ZPL send. Mirrors the mobile app's _sendRawTcp in
 * lan_zpl_printer.dart. Memory line 36: ZD500R prints reliably on raw
 * TCP 9100 from the Samsung handheld; HTTP /pstprnt 200's but doesn't
 * print. For desktop we keep BOTH transports and route by port — port
 * 9100 → raw TCP, anything else → HTTP /pstprnt.
 *
 * Connect, write ZPL, close. Most Zebra firmware doesn't echo; the
 * absence of a connection error is "ok." Returns null on success or
 * a short reason string on failure.
 */
async function sendZplViaTcp(host: string, port: number, zpl: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* swallow */
      }
      resolve(result);
    };
    const t = setTimeout(() => finish("TCP timeout"), DEFAULT_PRINT_TIMEOUT_MS);
    sock.once("connect", () => {
      sock.write(Buffer.from(zpl, "utf8"), (err) => {
        if (err) {
          clearTimeout(t);
          finish(err.message);
          return;
        }
        // 250ms grace: let the printer ingest the bytes before we tear down.
        setTimeout(() => {
          clearTimeout(t);
          finish(null);
        }, 250);
      });
    });
    sock.once("error", (err) => {
      clearTimeout(t);
      finish(err.message);
    });
  });
}

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

  // Server-side print path: works ONLY when the WMS has direct LAN
  // reachability to the printer (on-prem deploy, dev workstation on the
  // warehouse Wi-Fi). The cloud Coolify WMS cannot reach 192.168.1.3 —
  // for that, callers should send `X-Carbon-Client-Print: 1` so the
  // route returns the ZPL and the browser fires the print itself
  // (browser is on the LAN; printer is on the LAN; HTTP /pstprnt works).
  // Routes by port: 9100 → raw TCP, anything else → HTTP /pstprnt.
  if (parsed.printerPort === 9100) {
    const rawErr = await sendZplViaTcp(parsed.printerHost, parsed.printerPort, parsed.zpl);
    printer_ok = rawErr === null;
    printer_error = rawErr;
  } else {
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
