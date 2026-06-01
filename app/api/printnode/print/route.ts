import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  printNodeApiKey,
  printNodeDefaultPrinterId,
  submitPrintNodeJob,
} from "@/lib/server/printnode";
import { buildOlaHangtagZplBatch } from "@/lib/utils/zpl-ola-hangtag";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  item: z.object({
    sku: z.string().min(1),
    size: z.string().nullish(),
    color: z.string().nullish(),
    price: z.union([z.number(), z.string()]).nullish(),
    upc: z.string().nullish(),
    description: z.string().nullish(),
    sysid: z.union([z.number(), z.string()]),
    attr12: z.string().nullish(),
  }),
  qty: z.number().int().min(1).max(500),
  printerId: z.number().int().optional(),
  /** Optional starting serial for human reference (non-RFID has no chip encode). */
  startSerial: z.number().int().min(1).optional(),
});

/**
 * Non-RFID print path: build the OLA hang-tag ZPL (no chip encode) and submit it
 * to PrintNode. Session-gated by `proxy.ts` + the explicit check below.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!printNodeApiKey()) {
    return NextResponse.json(
      { error: "PrintNode not configured (PRINTNODE_API_KEY missing)" },
      { status: 503 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { item, qty } = parsed.data;
  const printerId = parsed.data.printerId ?? printNodeDefaultPrinterId();
  if (!printerId) {
    return NextResponse.json(
      { error: "No PrintNode printer selected (set PRINTNODE_PRINTER_ID or pass printerId)" },
      { status: 400 },
    );
  }

  // Non-RFID tags carry no EPC — same artwork, chip-encode lines omitted.
  const zpl = buildOlaHangtagZplBatch(item, parsed.data.startSerial ?? 1, qty, {
    includeRfid: false,
  });

  try {
    const jobId = await submitPrintNodeJob({
      printerId,
      zpl,
      title: `Carbon WMS — ${item.sku} ×${qty}`,
      source: "Carbon WMS · Non-RFID tags",
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
