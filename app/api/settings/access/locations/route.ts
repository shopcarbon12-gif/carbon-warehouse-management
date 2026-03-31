import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { insertTenantLocation, listTenantLocationsAdmin } from "@/lib/queries/settings-locations-admin";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listTenantLocationsAdmin(pool, session.tid);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[access/locations GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(256),
  lightspeedShopId: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
  userIds: z.array(z.string().uuid()).default([]),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const id = await insertTenantLocation(pool, session.tid, {
      code: parsed.data.code,
      name: parsed.data.name,
      lightspeed_shop_id: parsed.data.lightspeedShopId ?? null,
      is_active: parsed.data.isActive ?? true,
      userIds: parsed.data.userIds,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "Location code must be unique for this tenant" }, { status: 409 });
    }
    console.error("[access/locations POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
