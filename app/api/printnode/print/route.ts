import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  printNodeApiKey,
  printNodeDefaultPrinterId,
  printNodeRfidPrinterId,
  submitPrintNodeJob,
} from "@/lib/server/printnode";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import {
  buildOlaHangtagZpl,
  buildOlaHangtagZplBatch,
} from "@/lib/utils/zpl-ola-hangtag";
import { stripRfidEncoding } from "@/lib/utils/zpl-carbon-tag";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Raw ZPL to print as-is. RFID passes the commission API's ZPL (built by the
   *  canonical zpl-carbon-tag builder) so on-printer calibration is honored. */
  zpl: z.string().min(1).optional(),
  item: z
    .object({
      sku: z.string().min(1),
      size: z.string().nullish(),
      color: z.string().nullish(),
      price: z.union([z.number(), z.string()]).nullish(),
      upc: z.string().nullish(),
      description: z.string().nullish(),
      sysid: z.union([z.number(), z.string()]),
      attr12: z.string().nullish(),
    })
    .optional(),
  qty: z.number().int().min(1).max(500),
  /** RFID tags carry a chip encode (^RFW); non-RFID don't. */
  includeRfid: z.boolean().optional().default(false),
  /** Exact serials to encode (RFID — must match the DB-minted serials). */
  serials: z.array(z.number().int()).optional(),
  /** Starting serial when `serials` isn't given (non-RFID human reference). */
  startSerial: z.number().int().min(1).optional(),
  companyPrefix: z.number().int().optional(),
  /** Which configured printer to use; ignored if printerId is passed. */
  printerKind: z.enum(["rfid", "nonrfid"]).optional(),
  printerId: z.number().int().optional(),
});

/**
 * Print the OLA hang-tag via PrintNode (cloud → local client → printer). Used by
 * BOTH tabs so printing works from the HTTPS site (a browser can't POST to the
 * LAN printer). RFID includes the chip encode; non-RFID omits it.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!printNodeApiKey()) {
    return NextResponse.json(
      { error: "PrintNode not configured (PRINTNODE_API_KEY missing)" },
      { status: 503 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { zpl: rawZpl, item, qty, includeRfid, serials, printerKind } = parsed.data;
  if (!rawZpl && !item) {
    return NextResponse.json({ error: "Provide zpl or item" }, { status: 400 });
  }
  const cp = parsed.data.companyPrefix ?? envCompanyPrefix();

  const printerId =
    parsed.data.printerId ??
    (printerKind === "rfid" ? printNodeRfidPrinterId() : printNodeDefaultPrinterId());
  if (!printerId) {
    return NextResponse.json(
      {
        error:
          printerKind === "rfid"
            ? "No RFID printer in PrintNode (set PRINTNODE_RFID_PRINTER_ID, and add the Zebra to PrintNode)"
            : "No PrintNode printer selected (set PRINTNODE_PRINTER_ID or pass printerId)",
      },
      { status: 400 },
    );
  }

  // Prefer raw ZPL (RFID = the commission/zpl-carbon-tag output, calibrated on
  // the printer). Fall back to building the hang-tag here (non-RFID).
  // The Carbon PrintNode printer is a NON-RFID Jadens, so the chip-encode
  // commands (^RB/^RFW) in the commission ZPL would VOID/ignore on it. Strip
  // them and print the same visual tag — the EPC still lives in the DB
  // commission record. Set PRINTNODE_RFID_PRINTER_ENCODES=true if an
  // RFID-capable printer is ever attached to PrintNode and the chip should
  // actually be written.
  const rfidPrinterEncodes =
    String(process.env.PRINTNODE_RFID_PRINTER_ENCODES || "").trim().toLowerCase() === "true";
  const zpl =
    rawZpl !== undefined
      ? rfidPrinterEncodes
        ? rawZpl
        : stripRfidEncoding(rawZpl)
      : serials && serials.length > 0
        ? serials.map((s) => buildOlaHangtagZpl(item!, s, { includeRfid, companyPrefix: cp })).join("\n")
        : buildOlaHangtagZplBatch(item!, parsed.data.startSerial ?? 1, qty, {
            includeRfid,
            companyPrefix: cp,
          });
  const titleSku = item?.sku ?? "tag";

  try {
    const jobId = await submitPrintNodeJob({
      printerId,
      zpl,
      title: `Carbon WMS — ${titleSku} ×${qty}`,
      source: includeRfid ? "Carbon WMS · RFID tags" : "Carbon WMS · Non-RFID tags",
    });
    return NextResponse.json({ ok: true, jobId, qty }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[printnode/print]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "PrintNode submit failed" },
      { status: 502 },
    );
  }
}
