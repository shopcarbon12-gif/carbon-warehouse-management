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
  // Mobile app prints via raw TCP 9100 from-device (lan_zpl_printer.dart);
  // browser-side desktop print uses HTTP /pstprnt at port 80 (browsers
  // can't open raw TCP). Default to 80/PSTPRNT to match what a browser
  // can actually do; mobile callers explicitly pass 9100.
  const port = parsed.data.printerPort ?? 80;
  const uri = parsed.data.printerUri ?? "PSTPRNT";
  // Skip the server-side print attempt entirely when the caller is going
  // to print from-device (mobile handheld OR desktop browser on the LAN).
  // Cloud WMS at Coolify can't reach 192.168.1.3 anyway; trying just
  // wastes 12s of timeout. Both client paths receive the ZPL in the
  // response and fire the print themselves.
  //   X-Carbon-Mobile: 1        — Flutter handheld
  //   X-Carbon-Client-Print: 1  — desktop browser on the LAN
  //   printerIp === "skip"      — explicit opt-out for any caller
  const skipServerPrint =
    req.headers.get("x-carbon-mobile") === "1" ||
    req.headers.get("x-carbon-client-print") === "1" ||
    parsed.data.printerIp === "skip";

  const client = await pool.connect();
  let inTx = false;
  try {
    await client.query("BEGIN");
    inTx = true;
    const prep = await rfidCommissionPrepare(client, session, parsed.data);
    await client.query("COMMIT");
    inTx = false;

    const print = skipServerPrint
      ? {
          printer_ok: false,
          http_status: 0,
          printer_error: "skipped: client prints over LAN",
          printer_url: `http://${host}:${port}/${uri}`,
        }
      : await rfidCommissionPrintAndAudit(pool, session, {
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
      // ZPL is always returned so the handheld can fall back to a
      // direct TCP send when the server-side print fails (or was
      // skipped because the request originated from a mobile client).
      zpl: prep.zpl,
      printer_host: host,
      printer_port: port,
      printer_uri: uri,
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
