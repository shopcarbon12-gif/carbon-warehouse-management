import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { cleanBinContents } from "@/lib/queries/clean-bin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  binCode: z.string().min(1).max(128).trim(),
});

/**
 * Handheld: scan bin barcode → unassign all EPCs (same as web clean-bin, by code not UUID).
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.MANAGER]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const code = parsed.data.binCode.trim().toUpperCase();
  const bin = await pool.query<{ id: string }>(
    `SELECT b.id::text
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id
     WHERE l.tenant_id = $1::uuid AND l.id = $2::uuid AND upper(trim(b.code)) = upper(trim($3)) AND b.archived_at IS NULL
     LIMIT 1`,
    [session.tid, session.lid, code],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) {
    return NextResponse.json({ error: "Bin not found for active location" }, { status: 404 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await cleanBinContents(client, session.tid, binId);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, cleared: result.cleared, binCode: code });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[mobile/clean-bin]", e);
    return NextResponse.json({ error: "Clean failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
