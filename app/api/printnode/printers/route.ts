import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { listPrintNodePrinters, printNodeApiKey } from "@/lib/server/printnode";

export const dynamic = "force-dynamic";

/** List the account's PrintNode printers so the Non-RFID tab can offer a selector. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!printNodeApiKey()) {
    return NextResponse.json({ printers: [], configured: false });
  }
  try {
    const printers = await listPrintNodePrinters();
    return NextResponse.json(
      { printers, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[printnode/printers]", e);
    return NextResponse.json({ printers: [], configured: true, error: "fetch failed" });
  }
}
