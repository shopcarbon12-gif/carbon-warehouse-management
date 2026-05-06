import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { getSession, signOut, touchSession } from "@/lib/server/add-on-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * GET    /api/handheld/add-on-sessions/<id>          → session state
 * POST   /api/handheld/add-on-sessions/<id>?op=touch  → bump last_activity
 *                                       ?op=signout  → sign current operator out
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const { searchParams } = new URL(req.url);
  const auth = await resolveTenantOrError(req, pool, searchParams.get("deviceId") ?? undefined);
  if (auth instanceof Response) return auth;

  const session = await getSession(pool, auth.tenantId, id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op");
  const auth = await resolveTenantOrError(req, pool, searchParams.get("deviceId") ?? undefined);
  if (auth instanceof Response) return auth;

  if (op === "touch") {
    await touchSession(pool, auth.tenantId, id, auth.userId, auth.deviceId);
    return NextResponse.json({ ok: true });
  }
  if (op === "signout") {
    const updated = await signOut(pool, auth.tenantId, id, auth.userId, auth.deviceId);
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(updated);
  }
  return NextResponse.json({ error: "op must be 'touch' or 'signout'" }, { status: 400 });
}
