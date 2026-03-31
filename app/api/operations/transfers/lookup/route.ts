import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { lookupTransferEpcs } from "@/lib/server/operations-transfers";

const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(200),
});

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

  const parsed = bodySchema.safeParse(json);
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

  try {
    const rows = await lookupTransferEpcs(pool, session.tid, parsed.data.epcs);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[operations/transfers/lookup]", e);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
}
