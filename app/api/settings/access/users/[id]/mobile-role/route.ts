import { NextResponse } from "next/server";
import { z } from "zod";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";

/**
 * Assign (or clear) a WMS user's WMS Mobile (handheld) role. Decoupled from
 * the main user PATCH so changing the mobile role never touches the WMS role,
 * locations, or session role. Body: { mobileRoleId: number | null }. The role
 * must be a scope='mobile' user_roles row. Admin-only.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
const bodySchema = z.object({ mobileRoleId: z.number().int().positive().nullable() });

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
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
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
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const { mobileRoleId } = parsed.data;

  // The user must belong to the caller's tenant.
  const mem = await pool.query(
    `SELECT 1 FROM memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [id, session.tid],
  );
  if (mem.rowCount === 0) {
    return NextResponse.json({ error: "User not in this tenant" }, { status: 404 });
  }

  // If assigning a role, it must exist AND be scope='mobile'.
  if (mobileRoleId != null) {
    const role = await pool.query(
      `SELECT 1 FROM user_roles WHERE id = $1::int AND scope = 'mobile' LIMIT 1`,
      [mobileRoleId],
    );
    if (role.rowCount === 0) {
      return NextResponse.json({ error: "Not a valid mobile role" }, { status: 400 });
    }
  }

  await pool.query(`UPDATE users SET mobile_role_id = $2 WHERE id = $1::uuid`, [
    id,
    mobileRoleId,
  ]);

  return NextResponse.json({ ok: true });
}
