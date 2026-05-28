import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Single-variant catalog operations. Currently only Archive (set/unset
 * custom_skus.archived). Wired from the Lightspeed-style item-details
 * popup's Archive button. Admin-only.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

const patchSchema = z.object({
  archived: z.boolean(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid custom_sku id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const r = await pool.query(
    `UPDATE custom_skus
        SET archived = $2
      WHERE id = $1::uuid
        AND archived <> $2`,
    [id, parsed.data.archived],
  );

  return NextResponse.json({ ok: true, updated: r.rowCount ?? 0 });
}
