import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { cleanEpcs, scanOut } from "@/lib/server/scan-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan-out — the tags of the items being sent to a customer become `sold`.
 * Accepts LIVE (in-stock) or unknown tags; every attempt, accepted or not, is
 * recorded with the item's details (lib/server/scan-out.ts).
 *
 *   POST { epcs: string[], orderId?, orderName?, reader?, rssi?: { [epc]: dBm } }
 *   POST { epc }   — one tag, kept for older clients
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as {
    epc?: string;
    epcs?: string[];
    orderId?: string;
    orderName?: string;
    reader?: string;
    rssi?: Record<string, number>;
  };
  const epcs = cleanEpcs(body.epcs ?? (body.epc ? [body.epc] : []));
  if (!epcs.length) return NextResponse.json({ ok: false, error: "No valid EPC." }, { status: 400 });

  const results = await scanOut(
    pool,
    { tenantId: session.tid, userId: session.sub, locationId: session.lid ?? null },
    epcs,
    {
      orderId: body.orderId?.slice(0, 40) || null,
      orderName: body.orderName?.slice(0, 40) || null,
      reader: body.reader?.slice(0, 60) || null,
      rssi: body.rssi && typeof body.rssi === "object" ? body.rssi : undefined,
    },
  );
  const single = body.epcs ? null : results[0];
  return NextResponse.json(single ? { ...single, ok: single.ok } : { ok: results.every((r) => r.ok), results });
}
