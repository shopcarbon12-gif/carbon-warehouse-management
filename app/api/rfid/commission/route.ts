import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  commissionBodySchema,
  rfidCommissionPrepare,
  rfidCommissionPrintAndAudit,
} from "@/lib/server/rfid-commission";

/**
 * RFID commissioning: DB + ZPL (generateSGTIN96) + raw POST to printer + rfid_print audit.
 * Body: customSkuId, qty, addToInventory, binId?, companyPrefix?, printerIp?, printerPort?,
 * printerUri?, labelDimensions?: { w, h }.
 */
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

  const parsed = commissionBodySchema.safeParse(json);
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

  const host = parsed.data.printerIp ?? "192.168.1.3";
  const port = parsed.data.printerPort ?? 80;
  const uri = parsed.data.printerUri ?? "PSTPRNT";

  const client = await pool.connect();
  let inTx = false;
  try {
    await client.query("BEGIN");
    inTx = true;
    const prep = await rfidCommissionPrepare(client, session, parsed.data);
    await client.query("COMMIT");
    inTx = false;

    const print = await rfidCommissionPrintAndAudit(pool, session, {
      zpl: prep.zpl,
      printerHost: host,
      printerPort: port,
      printerUri: uri,
      meta: prep.meta,
    });

    return NextResponse.json({
      ok: true,
      inserted: prep.inserted,
      status_final: prep.status_final,
      printer_ok: print.printer_ok,
      http_status: print.http_status,
      printer_error: print.printer_error,
      printer_url: print.printer_url,
    });
  } catch (e) {
    if (inTx) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    console.error("[rfid/commission]", e);
    if ((e as { code?: string })?.code === "23505") {
      return NextResponse.json(
        { error: "Duplicate EPC (serial collision)" },
        { status: 500 },
      );
    }
    const msg = e instanceof Error ? e.message : "Commission failed";
    if (msg.startsWith("NOT_FOUND:")) {
      return NextResponse.json({ error: msg.slice(10) }, { status: 404 });
    }
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    if (msg.startsWith("SERVER:")) {
      return NextResponse.json({ error: msg.slice(7) }, { status: 500 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
