import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/push/test { kind?: "orders" | "studio" | "visitor" } → sends a test alert to
 * the signed-in user's own devices, so the phone and the computer (and their
 * sounds) can be checked without waiting for an order or a batch.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { sendPush } from "@/lib/server/web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const studio = body?.kind === "studio";
  if (body?.kind === "visitor") {
    const r = await sendPush(
      pool,
      { kind: "test", title: "New visitor · United States · Instagram · test", body: "Looking at Eden Dress 2 Pieces · phone — tap to open Visitors", url: "/shopify/visitors", tag: `test-visitor-${Date.now()}` },
      { userId: String(session.sub || "") || null },
    );
    return NextResponse.json({ ok: true, ...r, sound: null });
  }
  const r = await sendPush(
    pool,
    studio
      ? { kind: "test", title: "Studio · test alert", body: "This is how a finished night-batch run will look — tap to open the catalog", url: "/inventory/catalog", tag: "test-studio", sound: "studio" }
      : { kind: "test", title: "New Shopify order · test alert", body: "This is how a paid Shopify order will look — tap to open Sales", url: "/shopify/sales", tag: "test-orders", sound: "orders" },
    { userId: String(session.sub || "") || null },
  );
  /* The sound picked by the page follows the alert it imitates. */
  return NextResponse.json({ ok: true, ...r, sound: studio ? "studio" : "orders" });
}

export const POST = withActivity("push/test", POST_handler);
