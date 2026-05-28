import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  deactivateTenantRewardsUser,
  updateTenantRewardsUser,
} from "@/lib/queries/settings-rewards-users";

const patchSchema = z.object({
  rewardsRoleId: z.number().int().positive().nullable(),
  isActive: z.boolean(),
  resetPassword: z.string().min(6).max(128).optional(),
  firstName: z.string().trim().max(80).nullable().optional(),
  lastName: z.string().trim().max(80).nullable().optional(),
});

/**
 * PATCH /api/settings/access/rewards-users/{id}
 * Update a rewards user's role + active flag. Optionally reset the password.
 * `id` is the users.id (UUID).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
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
    const ok = await updateTenantRewardsUser(pool, session.tid, id, parsed.data);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/rewards-users PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/settings/access/rewards-users/{id}
 * Soft-deactivates the rewards user (sets rewards_employees.is_active = false).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const ok = await deactivateTenantRewardsUser(pool, session.tid, id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/rewards-users DELETE]", e);
    return NextResponse.json({ error: "Deactivate failed" }, { status: 500 });
  }
}
