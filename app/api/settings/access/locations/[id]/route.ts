import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { deleteTenantLocation, updateTenantLocation } from "@/lib/queries/settings-locations-admin";

const patchSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(256),
  lightspeedShopId: z.number().int().positive().nullable().optional(),
  isActive: z.boolean(),
  userIds: z.array(z.string().uuid()),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const ok = await updateTenantLocation(pool, session.tid, locationId, {
      code: parsed.data.code,
      name: parsed.data.name,
      lightspeed_shop_id: parsed.data.lightspeedShopId ?? null,
      is_active: parsed.data.isActive,
      userIds: parsed.data.userIds,
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "Location code or Lightspeed shop ID conflict" }, { status: 409 });
    }
    console.error("[access/locations PATCH]", e);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(_req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id: locationId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const ok = await deleteTenantLocation(pool, session.tid, locationId);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[access/locations DELETE]", e);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
