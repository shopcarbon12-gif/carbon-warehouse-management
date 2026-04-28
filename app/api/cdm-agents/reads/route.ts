import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  authenticateAgentToken,
  ingestAgentReads,
  ingestReadsSchema,
} from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carbon CDM agent endpoint. The agent batches tag reads off the
 * MonsoonReader stream and POSTs them here. Bearer-authenticates via the
 * agent's API token (NOT a user session).
 *
 * Request body:
 *   { readerId, reads: [{ epcHex, antennaNumber?, rssi?, readAt? }, ...] }
 *
 * Response: { ok: true, inserted: N }
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ingestReadsSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { inserted } = await ingestAgentReads(client, a, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, inserted });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Ingest failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cdm-agents/reads]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
