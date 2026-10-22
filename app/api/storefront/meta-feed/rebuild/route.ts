import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/storefront/meta-feed/rebuild — rebuild the Meta close-up feed in
 * the background (lib/server/meta-feed.ts). The worker calls it every 6 hours
 * with an admin session; it runs here because the web app holds the OpenAI key.
 * 202 = started, 409 = a build is already running. Admin only.
 */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { startMetaFeedBuild } from "@/lib/server/meta-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  return startMetaFeedBuild(pool)
    ? NextResponse.json({ ok: true }, { status: 202 })
    : NextResponse.json({ error: "A build is already running" }, { status: 409 });
}

export const POST = withActivity("storefront/meta-feed/rebuild", POST_handler);
