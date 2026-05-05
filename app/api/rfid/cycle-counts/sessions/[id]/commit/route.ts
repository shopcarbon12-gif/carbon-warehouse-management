import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { commitSession } from "@/lib/server/rfid-cycle-count-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const epcArr = z
  .array(z.string().transform((s) => s.replace(/\s/g, "").toUpperCase()))
  .optional();

const commitSchema = z.object({
  acceptMissing: epcArr,
  acceptMisplaced: epcArr,
  acceptUnrecognized: epcArr,
  notes: z.string().trim().max(2000).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let json: unknown = {};
  try {
    json = await req.json();
  } catch {
    /* empty body OK */
  }
  const parsed = commitSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const detail = await commitSession(client, session, id, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, session: detail });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Commit failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cycle-counts/sessions/commit]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
