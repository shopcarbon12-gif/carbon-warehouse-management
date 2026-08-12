import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { resolveShopContext, collectionCreate } from "@/lib/server/shopify-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a new manual Shopify collection (M4/P5). Assignment of products into
 * collections already happens automatically on publish via the taxonomy mapper;
 * this adds the missing "create a new collection" capability.
 *
 * POST { title, descriptionHtml? } → { id, handle }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { title?: string; descriptionHtml?: string };
  const title = (body.title || "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const res = await collectionCreate(ctx, { title, descriptionHtml: body.descriptionHtml });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, id: res.id, handle: res.handle });
}
