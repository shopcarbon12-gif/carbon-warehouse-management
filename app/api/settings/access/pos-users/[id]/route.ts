import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  deactivateTenantPosUser,
  updateTenantPosUser,
} from "@/lib/queries/settings-pos-users";

const patchSchema = z.object({
  posRoleId: z.number().int().positive().nullable(),
  isActive: z.boolean(),
  resetPin: z
    .string()
    .regex(/^\d{4}$/, "PIN must be 4 digits")
    .optional(),
  /** POS-specific password reset. Writes only to pos_employees.pos_password_hash;
   *  the user's WMS login (users.password_hash) is left alone. */
  resetPassword: z.string().min(6).max(128).optional(),
});

/**
 * PATCH /api/settings/access/pos-users/{id}
 * Update a POS user's role + active flag. Optionally reset the PIN.
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
    const ok = await updateTenantPosUser(pool, session.tid, id, {
      posRoleId: parsed.data.posRoleId,
      isActive: parsed.data.isActive,
      resetPin: parsed.data.resetPin,
      resetPassword: parsed.data.resetPassword,
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/pos-users PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/settings/access/pos-users/{id}
 * Soft-deactivates the POS user (sets pos_employees.is_active = false). We
 * never hard-delete because past sales reference cashier_id.
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
    const ok = await deactivateTenantPosUser(pool, session.tid, id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/pos-users DELETE]", e);
    return NextResponse.json({ error: "Deactivate failed" }, { status: 500 });
  }
}
