import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { addTransferItems, createTransferSlip, listTransferSlips } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  sourceLoc: z.string().min(1).max(256),
  destLoc: z.string().min(1).max(256),
  epcs: z.array(z.string().min(4).max(64)).optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const slips = await listTransferSlips(pool, session.tid);
    return NextResponse.json(slips, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[transfer-slips GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const slipNumber = await createTransferSlip(pool, session.tid, {
      source_loc: parsed.data.sourceLoc,
      dest_loc: parsed.data.destLoc,
      location_id: session.lid,
    });
    if (parsed.data.epcs?.length) {
      await addTransferItems(pool, session.tid, slipNumber, parsed.data.epcs);
    }
    return NextResponse.json({ ok: true, slipNumber }, { status: 201 });
  } catch (e) {
    console.error("[transfer-slips POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
