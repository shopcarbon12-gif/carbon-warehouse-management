import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { listTenantUsers, createTenantUser } from "@/lib/queries/settings-users";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listTenantUsers(pool, session.tid);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[access/users GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).optional(),
  roleId: z.number().int().positive(),
  locationIds: z.array(z.string().uuid()).default([]),
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
  const password = parsed.data.password ?? randomBytes(14).toString("base64url");
  try {
    const result = await createTenantUser(pool, session.tid, {
      email: parsed.data.email,
      password,
      roleId: parsed.data.roleId,
      locationIds: parsed.data.locationIds,
    });
    if (!result.ok) {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
    return NextResponse.json(
      {
        id: result.id,
        generatedPassword: parsed.data.password ? undefined : password,
      },
      { status: 201 },
    );
  } catch (e) {
    console.error("[access/users POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
