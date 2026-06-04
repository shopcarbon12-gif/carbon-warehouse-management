import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { commitReceive, transferReceiveSchema } from "@/lib/server/operations-transfers";
import { publishTransferEvent } from "@/lib/server/transfer-events-hub";

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

  const parsed = transferReceiveSchema.safeParse(json);
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await commitReceive(client, session, parsed.data);
    await client.query("COMMIT");
    publishTransferEvent(session.tid, {
      kind: "received",
      transferId: result.transferId,
      slipNumber: result.slipNumber,
      sourceLocationId: result.sourceLocationId,
      destinationLocationId: result.destinationLocationId,
      state: result.state,
      timestamp: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Receive failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[operations/transfers/receive]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
