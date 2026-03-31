import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { insertUserRole, listUserRoles } from "@/lib/queries/settings-user-roles";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listUserRoles(pool);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[access/user-roles GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

const postSchema = z.object({
  name: z.string().min(1).max(256),
  permissions: z.record(z.string(), z.record(z.string(), z.enum(["view", "hide"]))).optional(),
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
    const id = await insertUserRole(pool, parsed.data.name, parsed.data.permissions ?? {});
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "Role name already exists" }, { status: 409 });
    }
    console.error("[access/user-roles POST]", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
