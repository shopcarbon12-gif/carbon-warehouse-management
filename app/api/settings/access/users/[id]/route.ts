import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { removeUserFromTenant, updateTenantUser } from "@/lib/queries/settings-users";

const patchSchema = z.object({
  email: z.string().email().optional(),
  roleId: z.number().int().positive(),
  locationIds: z.array(z.string().uuid()),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id: userId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    await updateTenantUser(pool, session.tid, userId, {
      email: parsed.data.email,
      roleId: parsed.data.roleId,
      locationIds: parsed.data.locationIds,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "user_not_in_tenant") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[access/users PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id: userId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const ok = await removeUserFromTenant(pool, session.tid, userId);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/users DELETE]", e);
    return NextResponse.json({ error: "Remove failed" }, { status: 500 });
  }
}
