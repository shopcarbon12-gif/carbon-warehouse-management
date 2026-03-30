import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { deleteUserRole, updateUserRole } from "@/lib/queries/settings-user-roles";

const putSchema = z.object({
  name: z.string().min(1).max(256),
  permissions: z.record(z.string(), z.record(z.string(), z.enum(["view", "hide"]))),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const ok = await updateUserRole(pool, id, {
      name: parsed.data.name,
      permissions: parsed.data.permissions,
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "Role name already exists" }, { status: 409 });
    }
    console.error("[access/user-roles PUT]", e);
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

  const { id: idRaw } = await ctx.params;
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const result = await deleteUserRole(pool, id);
    if (result === "in_use") {
      return NextResponse.json({ error: "Role is assigned to users" }, { status: 409 });
    }
    if (result === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/user-roles DELETE]", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
