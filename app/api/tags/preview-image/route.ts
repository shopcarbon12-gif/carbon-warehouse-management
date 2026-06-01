import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  generateRfidTagPreview,
  generateNonRfidTag203,
} from "@/lib/utils/zpl-carbon-tag-203";
import type { CarbonTagInput } from "@/lib/utils/zpl-carbon-tag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Render the EXACT tag ZPL to a PNG via Labelary (same pattern as carbon-gen's
 * /api/rfid/labels/preview-image) so the on-screen label picture == what prints.
 * RFID = 300 dpi (12 dpmm, Zebra .3); Non-RFID = 203 dpi (8 dpmm, Zebra .220).
 * The ZPL (item name / SKU / price) is POSTed to api.labelary.com server-side.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      kind?: "rfid" | "nonrfid";
      input?: CarbonTagInput;
      sysid?: string | number;
      companyPrefix?: number;
      serial?: number;
    };
    const input = body.input;
    if (!input?.customSku) {
      return NextResponse.json({ error: "Select a product first." }, { status: 400 });
    }

    const kind = body.kind === "nonrfid" ? "nonrfid" : "rfid";
    const zpl =
      kind === "rfid"
        ? generateRfidTagPreview(input, body.sysid ?? "0", body.companyPrefix ?? 985_611, body.serial ?? 1)
        : generateNonRfidTag203(input);

    // Render at the TRUE physical label size so the picture reflects real stock:
    //   RFID    = 6.5 × 5 cm  (2.56 × 1.97 in) @ 12 dpmm — Zebra .3
    //   Non-RFID= 2 × 3 in stock; printed extent ~3.30 × 2.04 in @ 8 dpmm
    //             (the box icon pushes content to ~3.3" wide) — Zebra .220
    const dpmm = kind === "rfid" ? 12 : 8;
    const w = kind === "rfid" ? "2.56" : "3.30";
    const h = kind === "rfid" ? "1.97" : "2.04";

    const url = `https://api.labelary.com/v1/printers/${dpmm}dpmm/labels/${w}x${h}/0/`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Accept: "image/png", "Content-Type": "application/x-www-form-urlencoded" },
      body: zpl,
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      const details = await resp.text();
      return NextResponse.json(
        { error: "Preview provider rejected ZPL.", details: details.slice(0, 600) },
        { status: 502 },
      );
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return NextResponse.json(
      { imageDataUrl: `data:image/png;base64,${buf.toString("base64")}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unable to render preview." },
      { status: 400 },
    );
  }
}
