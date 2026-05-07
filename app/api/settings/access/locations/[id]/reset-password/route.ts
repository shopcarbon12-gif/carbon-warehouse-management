import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { resetTenantLocationPassword } from "@/lib/queries/settings-locations-admin";

const schema = z.object({
  password: z.string().min(4).max(128),
});

/**
 * POST /api/settings/access/locations/{id}/reset-password
 * Body: { password: string }
 * Bcrypts the new password and writes it to locations.password_hash. Existing
 * email is untouched; the location row itself is required to belong to the
 * caller's tenant.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id: locationId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const ok = await resetTenantLocationPassword(
      pool,
      session.tid,
      locationId,
      parsed.data.password,
    );
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/locations reset-password POST]", e);
    return NextResponse.json({ error: "Reset failed" }, { status: 500 });
  }
}
